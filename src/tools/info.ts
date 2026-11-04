import { dedent, llm } from '@livekit/agents';
import { z } from 'zod';

/** Same shape as the global `fetch`; simulations pass a fake one with canned data. */
export type Fetcher = typeof fetch;

// Wikimedia asks API clients to identify themselves.
const HEADERS = { 'User-Agent': 'HCI-voice-agent/1.0 (college project)' };

async function getJson<T>(httpFetch: Fetcher, url: string): Promise<T> {
  let response: Response;
  try {
    response = await httpFetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8_000) });
  } catch {
    throw new llm.ToolError('The service could not be reached. The internet may be down.');
  }
  if (!response.ok) {
    throw new llm.ToolError(`The service returned an error (status ${response.status}).`);
  }
  return (await response.json()) as T;
}

// WMO weather interpretation codes used by Open-Meteo.
// https://open-meteo.com/en/docs#weather_variable_documentation
function describeWeatherCode(code: number): string {
  if (code === 0) return 'clear sky';
  if (code <= 2) return 'partly cloudy';
  if (code === 3) return 'overcast';
  if (code <= 48) return 'foggy';
  if (code <= 57) return 'drizzle';
  if (code <= 67) return 'rain';
  if (code <= 77) return 'snow';
  if (code <= 82) return 'rain showers';
  if (code <= 86) return 'snow showers';
  return 'thunderstorm';
}

interface GeocodeResponse {
  results?: {
    name: string;
    latitude: number;
    longitude: number;
    country?: string;
    admin1?: string;
  }[];
}

interface ForecastResponse {
  current: {
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    weather_code: number;
    wind_speed_10m: number;
  };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: (number | null)[];
  };
}

interface WikiSearchResponse {
  pages: { key: string; title: string }[];
}

interface WikiSummaryResponse {
  type: string;
  title: string;
  description?: string;
  extract: string;
}

interface WikiExtractResponse {
  query: { pages: { extract?: string }[] };
}

export function createInfoTools(httpFetch: Fetcher = fetch) {
  const getWeather = llm.tool({
    name: 'getWeather',
    description: dedent`
      Get the current weather and a seven-day forecast for a city, in Celsius.
      If the user doesn't name a city, ask which city before calling this.
      Answer only the part the user asked about (for example just tomorrow), not the whole week.
    `,
    parameters: z.object({
      city: z
        .string()
        .describe('City name, optionally with country, e.g. "Delhi" or "Paris, France"'),
    }),
    execute: async ({ city }) => {
      const geo = await getJson<GeocodeResponse>(
        httpFetch,
        `https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(city)}`,
      );
      const place = geo.results?.[0];
      if (!place) {
        throw new llm.ToolError(
          `No city called "${city}" was found. Ask the user to repeat or spell it.`,
        );
      }

      const forecast = await getJson<ForecastResponse>(
        httpFetch,
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
          '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m' +
          '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
          '&timezone=auto&forecast_days=7',
      );
      const { current, daily } = forecast;
      return {
        location: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
        now: {
          condition: describeWeatherCode(current.weather_code),
          temperatureC: Math.round(current.temperature_2m),
          feelsLikeC: Math.round(current.apparent_temperature),
          humidityPercent: current.relative_humidity_2m,
          windKmh: Math.round(current.wind_speed_10m),
        },
        days: daily.time.map((date, i) => ({
          // Dates are local to the city; parse as UTC so the weekday doesn't shift.
          day:
            i === 0
              ? 'today'
              : i === 1
                ? 'tomorrow'
                : new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
                    weekday: 'long',
                    timeZone: 'UTC',
                  }),
          date,
          condition: describeWeatherCode(daily.weather_code[i]!),
          highC: Math.round(daily.temperature_2m_max[i]!),
          lowC: Math.round(daily.temperature_2m_min[i]!),
          chanceOfRainPercent: daily.precipitation_probability_max[i] ?? null,
        })),
      };
    },
  });

  const lookupWikipedia = llm.tool({
    name: 'lookupWikipedia',
    description: dedent`
      Look up a topic on Wikipedia and get a summary to tell the user.
      Use this ONLY when the user explicitly asks you to look something up, search the web, search online, or check Wikipedia.
      For ordinary questions they don't ask you to look up, answer from your own knowledge without this tool.
      Use detail "more" when the user asks for more about a topic you already looked up.
      If the result is ambiguous, tell the user the main options and ask which one they mean.
      Mention that the information comes from Wikipedia.
    `,
    parameters: z.object({
      topic: z.string().describe('The topic to look up, e.g. "Fitts\'s law" or "Don Norman"'),
      detail: z
        .enum(['summary', 'more'])
        .optional()
        .describe('"summary" (default) for a short answer, "more" for the full introduction'),
    }),
    execute: async ({ topic, detail = 'summary' }) => {
      const search = await getJson<WikiSearchResponse>(
        httpFetch,
        `https://en.wikipedia.org/w/rest.php/v1/search/page?limit=1&q=${encodeURIComponent(topic)}`,
      );
      const page = search.pages[0];
      if (!page) {
        throw new llm.ToolError(`Wikipedia has no article matching "${topic}".`);
      }

      const summary = await getJson<WikiSummaryResponse>(
        httpFetch,
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page.key)}`,
      );
      if (summary.type === 'disambiguation') {
        return {
          ambiguous: true,
          title: summary.title,
          possibleMeanings: summary.extract.split('\n').slice(0, 5),
        };
      }

      if (detail === 'more') {
        const intro = await getJson<WikiExtractResponse>(
          httpFetch,
          'https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1' +
            `&format=json&formatversion=2&titles=${encodeURIComponent(summary.title)}`,
        );
        const text = intro.query.pages[0]?.extract ?? summary.extract;
        // Keep the context small; the agent only speaks a few sentences anyway.
        return { title: summary.title, source: 'Wikipedia', text: text.slice(0, 2_000) };
      }

      return {
        title: summary.title,
        description: summary.description,
        source: 'Wikipedia',
        text: summary.extract,
      };
    },
  });

  return [getWeather, lookupWikipedia];
}
