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
declare function clearTimeout(timeoutId: NodeJS.Timeout | undefined): void;
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

declare module "node:fs" {
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
  export function writeFileSync(...args: any[]): void;
}

declare module "node:os" {
  export function homedir(): string;
  export function tmpdir(): string;
}

declare module "node:path" {
  export const sep: string;
  export function dirname(path: string): string;
  export function join(...segments: string[]): string;
  export function normalize(path: string): string;
  export function resolve(...segments: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: unknown): string;
}

declare module "bun:test" {
  export const mock: {
    module(name: string, factory: () => Record<string, unknown>): void;
  };
}

declare module "@mariozechner/pi-coding-agent" {
  export type Theme = any;

  export interface ExtensionUIContext {
    select(title: string, options: string[], opts?: any): Promise<string | undefined>;
    confirm(title: string, message: string, opts?: any): Promise<boolean>;
    input(title: string, placeholder?: string, opts?: any): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    custom<T>(renderer: (...args: any[]) => any, options?: any): Promise<T>;
  }

  export interface ExtensionContext {
    ui: ExtensionUIContext;
    hasUI: boolean;
    cwd: string;
    sessionManager: any;
    modelRegistry: any;
    model: any;
    abort(): Promise<void> | void;
    getSystemPrompt(): string;
  }

  export interface ExtensionCommandContext extends ExtensionContext {}

  export interface ExtensionAPI {
    on(event: string, handler: (...args: any[]) => any): void;
    getAllTools(): any[];
    setActiveTools(toolNames: string[]): void;
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

  export function getSettingsListTheme(...args: any[]): any;
  export function isToolCallEventType(toolName: string, event: unknown): boolean;
}

declare module "@mariozechner/pi-tui" {
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
