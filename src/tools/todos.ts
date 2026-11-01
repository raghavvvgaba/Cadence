import { dedent, llm } from '@livekit/agents';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

export interface Todo {
  id: number;
  text: string;
  done: boolean;
  createdAt: string;
}

/** Where the to-do list lives. Tools only see this interface. */
export interface TodoStore {
  load(): Promise<Todo[]>;
  save(todos: Todo[]): Promise<void>;
}

/** Keeps the list in a JSON file, so it survives agent restarts. */
export class FileTodoStore implements TodoStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<Todo[]> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Todo[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async save(todos: Todo[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    // Write to a temp file and rename it over the real one, so a crash
    // mid-write can't leave a half-written, unreadable list behind.
    const temp = `${this.path}.tmp`;
    await writeFile(temp, JSON.stringify(todos, null, 2) + '\n');
    await rename(temp, this.path);
  }
}

/** Keeps the list in memory. Simulations use it so they never touch the real file. */
export class MemoryTodoStore implements TodoStore {
  private todos: Todo[];

  constructor(initial: Todo[] = []) {
    this.todos = structuredClone(initial);
  }

  async load(): Promise<Todo[]> {
    return structuredClone(this.todos);
  }

  async save(todos: Todo[]): Promise<void> {
    this.todos = structuredClone(todos);
  }
}

export function createTodoTools(store: TodoStore) {
  // Tools can run concurrently, so chain every read-modify-write onto one
  // queue; otherwise two quick adds could each overwrite the other's change.
  let queue: Promise<unknown> = Promise.resolve();
  const update = <T>(change: (todos: Todo[]) => T): Promise<T> => {
    const next = queue.then(async () => {
      const todos = await store.load();
      const result = change(todos);
      await store.save(todos);
      return result;
    });
    queue = next.catch(() => {});
    return next;
  };

  const summarize = (todos: Todo[]) => todos.map(({ id, text, done }) => ({ id, text, done }));

  const idsParameter = z
    .array(z.number().int())
    .min(1)
    .describe('Ids of the items, as returned by listTodos or addTodo');

  // Splits ids into the items they matched and any ids that don't exist.
  const pick = (todos: Todo[], ids: number[]) => ({
    matched: todos.filter((todo) => ids.includes(todo.id)),
    unknownIds: ids.filter((id) => !todos.some((todo) => todo.id === id)),
  });

  const addTodo = llm.tool({
    name: 'addTodo',
    description: dedent`
      Add one or more items to the user's to-do list. When the user lists several items, pass them all in a single call.
      Use the user's own wording for each item, kept short.
    `,
    parameters: z.object({
      texts: z.array(z.string().min(1)).min(1).describe('The items to add, e.g. ["finish slides"]'),
    }),
    execute: async ({ texts }, { ctx }) => {
      ctx.disallowInterruptions();
      return update((todos) => {
        let nextId = Math.max(0, ...todos.map((todo) => todo.id)) + 1;
        const added = texts.map((text) => ({
          id: nextId++,
          text: text.trim(),
          done: false,
          createdAt: new Date().toISOString(),
        }));
        todos.push(...added);
        return { added: summarize(added) };
      });
    },
  });

  const listTodos = llm.tool({
    name: 'listTodos',
    description: dedent`
      Get the user's to-do list. Call it whenever the user asks what is on their list,
      and before completing or removing items if you don't already know their ids.
    `,
    parameters: z.object({}),
    execute: async () => {
      const todos = await store.load();
      return {
        pending: summarize(todos.filter((todo) => !todo.done)),
        done: summarize(todos.filter((todo) => todo.done)),
      };
    },
  });

  const completeTodo = llm.tool({
    name: 'completeTodo',
    description: dedent`
      Mark items on the to-do list as done. They stay on the list, marked done, until removed.
      If it's unclear which item the user means, ask before calling this.
    `,
    parameters: z.object({ ids: idsParameter }),
    execute: async ({ ids }, { ctx }) => {
      ctx.disallowInterruptions();
      return update((todos) => {
        const { matched, unknownIds } = pick(todos, ids);
        for (const todo of matched) todo.done = true;
        return { completed: summarize(matched), unknownIds };
      });
    },
  });

  const removeTodo = llm.tool({
    name: 'removeTodo',
    description: dedent`
      Permanently delete items from the to-do list. Use this only when the user asks to remove or delete items,
      not when they finished them (use completeTodo for that).
      If it's unclear which item the user means, ask before calling this.
    `,
    parameters: z.object({ ids: idsParameter }),
    execute: async ({ ids }, { ctx }) => {
      ctx.disallowInterruptions();
      return update((todos) => {
        const { matched, unknownIds } = pick(todos, ids);
        const remaining = todos.filter((todo) => !matched.includes(todo));
        todos.splice(0, todos.length, ...remaining);
        return { removed: summarize(matched), unknownIds };
      });
    },
  });

  return [addTodo, listTodos, completeTodo, removeTodo];
}
