import { ServerOptions, cli, defineAgent, inference, voice } from '@livekit/agents';
import { EnhancerModel, audioEnhancement } from '@livekit/plugins-ai-coustics';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createAgent } from './agent.ts';
import { dryRunCommand, runCommand } from './tools/system.ts';
import { FileTodoStore, MemoryTodoStore, type Todo } from './tools/todos.ts';

// Load environment variables from a local file.
// Make sure to set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET
// when running locally or self-hosting your agent server.
dotenv.config({ path: '.env.local' });

export default defineAgent({
  entry: async (ctx) => {
    // `lk agent simulate` runs this agent on the local machine, so don't let
    // test scenarios really open apps or change the volume. Set
    // MAC_TOOLS_DRY_RUN=1 to get the same behavior elsewhere (e.g. the debugger).
    const dryRun = ctx.simulationContext() !== undefined || process.env.MAC_TOOLS_DRY_RUN === '1';

    // The to-do list lives in data/todos.json (or TODOS_FILE). Each simulation
    // gets its own in-memory list instead, optionally seeded from the
    // scenario's `userdata.todos`, so test runs never touch the real file.
    const sim = ctx.simulationContext();
    const todoStore = sim
      ? new MemoryTodoStore((sim.userdata().todos as Todo[] | undefined) ?? [])
      : new FileTodoStore(
          process.env.TODOS_FILE ?? fileURLToPath(new URL('../data/todos.json', import.meta.url)),
        );

    // Set up a voice AI pipeline using AssemblyAI, Fish Audio, and the LiveKit turn detector
    const session = new voice.AgentSession({
      // Speech-to-text (STT) is your agent's ears, turning the user's speech into text that the LLM can understand
      // See all available models at https://docs.livekit.io/agents/models/stt/
      stt: new inference.STT({
        model: 'assemblyai/universal-3-6-pro',
        language: 'en',
      }),

      // Keyterms bias the STT toward distinctive words it would otherwise misspell.
      // List your own names, brands, and jargon in `keyterms`. Detection additionally
      // extracts terms from the live conversation, such as a caller's name, and applies
      // them once the transcript corroborates the spelling.
      // See more at https://docs.livekit.io/agents/models/stt/keyterms/
      keytermsOptions: {
        keyterms: ['LiveKit', 'Spotify', 'YouTube', 'Google Chrome', 'VS Code', 'lo-fi', 'to-do'],
        keytermDetection: { enabled: true },
      },

      // Text-to-speech (TTS) is your agent's voice, turning the LLM's text into speech that the user can hear
      // See all available models as well as voice selections at https://docs.livekit.io/agents/models/tts/
      tts: new inference.TTS({
        model: 'fishaudio/s2.1-pro',
        voice: 'fa4c9eb3dccc4806b382b40d61c6b10a',
      }),

      turnHandling: {
        // Turn detection determines when the user is speaking and when the agent should respond.
        // The LiveKit audio turn detector is a multimodal model that encodes the user's audio
        // directly to predict end of turn. It's built into the SDK (no extra plugin) and
        // AgentSession supplies the required VAD automatically.
        // See more at https://docs.livekit.io/agents/logic/turns/turn-detector/
        turnDetection: new inference.TurnDetector(),
        // Adaptive interruptions use the turn detector to tell a real interruption from a
        // backchannel like "mhm" or "right", so the agent keeps talking through the latter.
        // This model is on by default on LiveKit Cloud and in dev mode. To use the model elsewhere,
        // uncomment the `interruption` line. Self-hosted usage past the monthly allowance is billed.
        // See https://docs.livekit.io/deploy/admin/quotas-and-limits/#adaptive-interruption-handling for more information.
        // interruption: { mode: 'adaptive' },
        // Allow the LLM to generate a response while waiting for the end of turn
        preemptiveGeneration: { enabled: true },
      },

      // Expressive mode injects the TTS provider's markup guide into the LLM prompt, so the model
      // emits inline delivery tags (emotion, pacing, non-verbal sounds) that the TTS renders and
      // the transcript never shows. Requires a TTS model that supports markup, such as the Fish
      // Audio model above.
      expressive: true,
    });

    // Start the session, which initializes the voice pipeline and warms up the models
    await session.start({
      agent: createAgent({ run: dryRun ? dryRunCommand : runCommand, todoStore }),
      room: ctx.room,
      inputOptions: {
        // ai-coustics QUAIL audio enhancement for noise cancellation
        // Works for both WebRTC and telephony (SIP) participants
        noiseCancellation: audioEnhancement({ model: EnhancerModel.QuailVfS }),
      },
    });

    // // Add a virtual avatar to the session, if desired
    // // For other providers, see https://docs.livekit.io/agents/models/avatar/
    // const avatar = new anam.AvatarSession({
    //   personaConfig: {
    //     name: '...',
    //     avatarId: '...', // See https://docs.livekit.io/agents/models/avatar/plugins/anam
    //   },
    // });
    // // Start the avatar and wait for it to join
    // await avatar.start(session, ctx.room);

    // Join the room and connect to the user
    await ctx.connect();

    // Greet the user on joining
    session.generateReply({
      instructions: 'Greet the user in one short sentence, like "Hi, what can I do for you?"',
    });
  },
});

// Run the agent server
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'my-agent',
  }),
);
