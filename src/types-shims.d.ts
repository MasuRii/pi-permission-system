declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined;
  }

  interface Process {
    env: ProcessEnv;
    platform: string;
    pid: number;
    exitCode?: number;
    cwd(): string;
  }

  type Timeout = number;
}

declare const process: NodeJS.Process;

declare const console: {
  log(...args: any[]): void;
  error(...args: any[]): void;
};

declare function setTimeout(
  handler: (...args: any[]) => void,
  timeout?: number,
  ...args: any[]
): NodeJS.Timeout;
declare function clearTimeout(timeoutId: NodeJS.Timeout | null | undefined): void;
declare function setInterval(
  handler: (...args: any[]) => void,
  timeout?: number,
  ...args: any[]
): NodeJS.Timeout;
declare function clearInterval(timeoutId: NodeJS.Timeout | null | undefined): void;

declare module "node:assert/strict" {
  const assert: any;
  export default assert;
}

declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(value: string): { digest(encoding: string): string };
  };
}

declare module "node:fs" {
  export interface FSWatcher {
    close(): void;
    on(event: "error", listener: (error: unknown) => void): this;
  }
  export function appendFileSync(...args: any[]): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(...args: any[]): any;
  export function mkdtempSync(...args: any[]): string;
  export function readFileSync(...args: any[]): string;
  export function readdirSync(...args: any[]): string[];
  export function renameSync(...args: any[]): void;
  export function rmSync(...args: any[]): void;
  export function rmdirSync(...args: any[]): void;
  export function statSync(...args: any[]): { mtimeMs: number };
  export function unlinkSync(...args: any[]): void;
  export function watch(...args: any[]): FSWatcher;
  export function writeFileSync(...args: any[]): void;
}

declare module "node:os" {
  export function homedir(): string;
  export function tmpdir(): string;
}

declare module "node:path" {
  export const sep: string;
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function join(...segments: string[]): string;
  export function normalize(path: string): string;
  export function resolve(...segments: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: unknown): string;
}

declare module "node:test" {
  export const mock: {
    module(name: string, options: { namedExports?: Record<string, unknown>; defaultExport?: unknown }): void;
  };
}

declare module "@earendil-works/pi-coding-agent" {
  export interface Theme {
    fg(color: string, text: string): string;
    bold(text: string): string;
    colorizeForeground(color: string, text: string): string;
  }

  export interface TUI {
    requestRender(): void;
  }

  export type ExtensionCustomRenderer = (
    tui: TUI,
    theme: Theme,
    keybindings: unknown,
    done: (result?: unknown) => void,
  ) => {
    render(width: number): string[];
    invalidate(): void;
    handleInput(data: string): void;
  };

  export interface ExtensionUIContext {
    select(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
    confirm(title: string, message: string, opts?: unknown): Promise<boolean>;
    input(title: string, placeholder?: string, opts?: unknown): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, value: string | undefined): void;
    custom<T>(renderer: ExtensionCustomRenderer, options?: unknown): Promise<T>;
  }

  export interface ReadonlySessionManager {
    getEntries(): ReadonlyArray<unknown>;
    getSessionId(): string;
    getSessionDir(): string | undefined;
  }

  export interface ExtensionContext {
    ui: ExtensionUIContext;
    hasUI: boolean;
    cwd: string;
    sessionManager: ReadonlySessionManager;
    modelRegistry: unknown;
    model: unknown;
    abort(): Promise<void> | void;
    getSystemPrompt(): string;
  }

  export interface ExtensionCommandContext extends ExtensionContext {}

  export interface SessionStartEvent {
    reason?: "start" | "reload" | string;
  }

  export interface ResourcesDiscoverEvent {
    reason?: "discover" | "reload" | string;
  }

  export interface BeforeAgentStartEvent {
    // Some hosts (e.g. OMP) pass string[]; classic Pi passes string.
    systemPrompt: string | string[];
  }

  export interface InputEvent {
    text: string;
  }

  export interface ToolCallEvent {
    toolCallId: string;
    input: Record<string, unknown>;
  }

  export type ExtensionHandler<E, R = void> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

  export interface ExtensionAPI {
    on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
    on(event: "resources_discover", handler: ExtensionHandler<ResourcesDiscoverEvent>): void;
    on(event: "session_shutdown", handler: () => Promise<void> | void): void;
    on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
    on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;
    on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
    on(event: string, handler: (...args: any[]) => any): void;
    getAllTools(): unknown[];
    setActiveTools(toolNames: string[]): void;
    registerProvider?(...args: any[]): void;
    registerCommand(
      name: string,
      definition: {
        description: string;
        getArgumentCompletions?: (argumentPrefix: string) => Array<{ value: string; label: string; description?: string }> | null;
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
      },
    ): void;
    events: {
      emit(channel: string, payload: unknown): void;
    };
  }

  export interface BeforeAgentStartEventResult {
    // Hosts may accept string | string[]; runners can coerce string -> [string].
    systemPrompt?: string | string[];
  }

  export interface InputEventResult {
    action: "continue";
  }

  export interface ToolCallEventResult {
    block?: boolean;
    reason?: string;
  }

  export function getAgentDir(): string;
  export function getSettingsListTheme(...args: any[]): any;
  export function isToolCallEventType(toolName: string, event: unknown): boolean;
}

declare module "@earendil-works/pi-ai" {
  export type Api = string;
  export type AssistantMessageEventStream = AsyncIterable<unknown>;
  export type Context = Record<string, unknown>;
  export type SimpleStreamOptions = {
    temperature?: number;
    onPayload?: (payload: unknown, model: Model<Api>) => unknown | Promise<unknown | undefined> | undefined;
    [key: string]: any;
  };
  export interface Model<TApi extends Api> {
    id: string;
    api: TApi;
    provider: string;
    reasoning: boolean;
    [key: string]: any;
  }
  export function getApiProvider(api: Api): { streamSimple: (...args: unknown[]) => AssistantMessageEventStream } | undefined;
}

declare module "@earendil-works/pi-tui" {
  export interface SettingItem {
    id: string;
    label: string;
    description: string;
    currentValue: string;
    values: readonly string[] | string[];
  }

  export class Box {
    constructor(...args: any[]);
    addChild(...args: any[]): void;
    render(...args: any[]): string[];
    invalidate(...args: any[]): void;
  }

  export class Container {
    constructor(...args: any[]);
    addChild(...args: any[]): void;
    render(...args: any[]): string[];
    invalidate(...args: any[]): void;
  }

  export class SettingsList {
    constructor(...args: any[]);
    handleInput(...args: any[]): void;
    updateValue(id: string, value: string): void;
    render(...args: any[]): string[];
    invalidate(...args: any[]): void;
  }

  export class Spacer {
    constructor(...args: any[]);
  }

  export class Text {
    constructor(...args: any[]);
  }

  export function truncateToWidth(text: string, width: number, filler?: string, preferEnd?: boolean): string;
  export function visibleWidth(text: string): number;
}
