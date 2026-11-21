// The part of the Claude engine's plugin types (`claude-code`, which resolves only from the engine's own file) that
// the Life plugin's `hooks/life.ts` uses, so the gate type-checks that module. Widen it when the plugin uses more.
declare module "claude-code" {
  export interface EngineInterface {
    env: { get: (name: string) => Promise<string | undefined> };
    http: {
      fetch: (
        url: string,
        init?: {
          body?: string;
          headers?: Record<string, string>;
          method?: string;
        }
      ) => Promise<{ status: number; text: string }>;
    };
    plugin: { name: string };
    session: { id: () => Promise<string> };
    store: {
      get: (key: string) => Promise<unknown>;
      set: (key: string, value: unknown) => Promise<void>;
    };
    tool: {
      register: (tool: {
        description: string;
        inputSchema: unknown;
        isDeferred: boolean;
        name: string;
      }) => Promise<void>;
    };
  }
  export type Next = ((e: Event) => Promise<unknown>) & { called: boolean };
  // biome-ignore lint/suspicious/noExplicitAny: an event's fields differ per hook
  export type Event = any;
  export type Handler = (
    $: EngineInterface,
    e: Event,
    next: Next
  ) => Promise<unknown>;
  export interface Hooked {
    catch: (h: (_$: EngineInterface, e: Event, next: Next) => unknown) => void;
  }
  export type Register = (on: (event: string, h: Handler) => Hooked) => void;
}
