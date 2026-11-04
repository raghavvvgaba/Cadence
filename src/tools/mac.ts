import { dedent, llm } from '@livekit/agents';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { CommandRunner } from './system.ts';

const APP_FOLDERS = ['/Applications', '/System/Applications', join(homedir(), 'Applications')];

async function listInstalledApps(): Promise<string[]> {
  const names = new Set<string>();
  for (const folder of APP_FOLDERS) {
    try {
      for (const entry of await readdir(folder)) {
        if (entry.endsWith('.app')) names.add(entry.slice(0, -'.app'.length));
      }
    } catch {
      // Folder doesn't exist on this machine (or isn't macOS); skip it.
    }
  }
  return [...names];
}

// Speech-to-text often mangles app names ("spotty fly", "vs code"), so when
// `open` fails we offer the closest installed names for the agent to suggest.
function closestApps(query: string, apps: string[], limit = 3): string[] {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const q = normalize(query);
  return apps
    .map((app) => {
      const a = normalize(app);
      const score = a.includes(q) || q.includes(a) ? 0 : editDistance(q, a) / Math.max(q.length, 1);
      return { app, score };
    })
    .filter(({ score }) => score < 0.5)
    .sort((x, y) => x.score - y.score)
    .slice(0, limit)
    .map(({ app }) => app);
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = temp;
    }
  }
  return row[b.length]!;
}

const SEARCH_URLS = {
  google: 'https://www.google.com/search?q=',
  youtube: 'https://www.youtube.com/results?search_query=',
} as const;

// YouTube has no keyless search API, but its results page embeds the result
// data as JSON, so the first video's id and title can be read straight from it.
async function firstYouTubeVideo(query: string): Promise<{ id: string; title: string } | null> {
  try {
    const response = await fetch(SEARCH_URLS.youtube + encodeURIComponent(query), {
      headers: { 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const match = (await response.text()).match(
      /"videoRenderer":\{"videoId":"([\w-]{11})".*?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/,
    );
    if (!match) return null;
    return { id: match[1]!, title: JSON.parse(`"${match[2]}"`) as string };
  } catch {
    return null;
  }
}

export function createMacTools(run: CommandRunner) {
  const openApp = llm.tool({
    name: 'openApp',
    description: dedent`
      Open (launch) one or more applications on the user's Mac, for example Spotify, Safari, Google Chrome, Notes, or Visual Studio Code.
      When the user asks for several apps, pass them all in a single call.
      Any app that isn't found is listed with similar installed apps; ask the user which one they meant.
    `,
    parameters: z.object({
      appNames: z
        .array(z.string())
        .min(1)
        .describe(
          'Application names as they appear in the Applications folder, e.g. ["Google Chrome", "Notes"]',
        ),
    }),
    execute: async ({ appNames }) => {
      const opened: string[] = [];
      const notFound: { appName: string; similarInstalledApps: string[] }[] = [];
      for (const appName of appNames) {
        try {
          await run('open', ['-a', appName]);
          opened.push(appName);
        } catch {
          notFound.push({
            appName,
            similarInstalledApps: closestApps(appName, await listInstalledApps()),
          });
        }
      }
      if (opened.length === 0) {
        throw new llm.ToolError(`None of the apps were found: ${JSON.stringify(notFound)}`);
      }
      return notFound.length > 0 ? { opened, notFound } : { opened };
    },
  });

  const showSearchResults = llm.tool({
    name: 'showSearchResults',
    description: dedent`
      Open a Google or YouTube search results page in the user's default browser, for the user to read themselves.
      Use it only when the user says "Google" or asks to see or open search results on screen.
      When they ask you to look something up, search the web, or search online, use lookupWikipedia instead.
      Use YouTube when the user wants to browse videos; to play something, use playYouTube instead.
      This only opens the results page on screen. It does not read the results back.
    `,
    parameters: z.object({
      query: z.string().describe('What to search for, e.g. "lofi study music"'),
      site: z.enum(['google', 'youtube']).describe('Where to search'),
    }),
    execute: async ({ query, site }) => {
      await run('open', [SEARCH_URLS[site] + encodeURIComponent(query)]);
      return { searched: query, site };
    },
  });

  const playYouTube = llm.tool({
    name: 'playYouTube',
    description: dedent`
      Play a video or music on YouTube in the user's default browser by opening the top search result.
      Use this when the user asks to play, put on, or watch something.
      The result says which video started; if no video could be found, it opened the search results instead.
    `,
    parameters: z.object({
      query: z.string().describe('What to play, e.g. "lofi study music"'),
    }),
    execute: async ({ query }) => {
      const video = await firstYouTubeVideo(query);
      if (!video) {
        await run('open', [SEARCH_URLS.youtube + encodeURIComponent(query)]);
        return { playing: null, openedSearchResultsFor: query };
      }
      await run('open', [`https://www.youtube.com/watch?v=${video.id}`]);
      return { playing: video.title };
    },
  });

  const openWebsite = llm.tool({
    name: 'openWebsite',
    description: dedent`
      Open a specific website in the user's default browser, for example github.com or wikipedia.org.
      Use this when the user names a site to visit, not when they want to search for something.
    `,
    parameters: z.object({
      url: z
        .string()
        .describe('The website address, e.g. "github.com" or "https://news.ycombinator.com"'),
    }),
    execute: async ({ url }) => {
      let parsed: URL;
      try {
        parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
      } catch {
        throw new llm.ToolError(`"${url}" is not a valid website address.`);
      }
      if (!parsed.hostname.includes('.')) {
        throw new llm.ToolError(`"${url}" is not a valid website address.`);
      }
      await run('open', [parsed.href]);
      return { opened: parsed.hostname };
    },
  });

  const controlVolume = llm.tool({
    name: 'controlVolume',
    description: dedent`
      Change the Mac's output volume.
      Use "set" for an exact level, "increase" or "decrease" for relative changes like "a bit louder", and "mute" or "unmute".
    `,
    parameters: z.object({
      action: z.enum(['set', 'increase', 'decrease', 'mute', 'unmute']),
      level: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe(
          'For "set": the target level from 0 to 100. For "increase"/"decrease": how much to change it by (defaults to 15). Omit for mute and unmute.',
        ),
    }),
    execute: async ({ action, level }) => {
      if (action === 'mute' || action === 'unmute') {
        await run('osascript', ['-e', `set volume output muted ${action === 'mute'}`]);
        return { muted: action === 'mute' };
      }

      const current = Number.parseInt(
        await run('osascript', ['-e', 'output volume of (get volume settings)']),
        10,
      );
      const previous = Number.isNaN(current) ? 50 : current;

      let target: number;
      if (action === 'set') {
        if (level === undefined) throw new llm.ToolError('A target level is needed for "set".');
        target = level;
      } else {
        const step = level ?? 15;
        target = action === 'increase' ? previous + step : previous - step;
      }
      target = Math.max(0, Math.min(100, target));

      // Setting a level doesn't clear mute on macOS, so unmute explicitly.
      await run('osascript', ['-e', `set volume output volume ${target} without output muted`]);
      return { previousLevel: previous, level: target };
    },
  });

  return [openApp, showSearchResults, playYouTube, openWebsite, controlVolume];
}
