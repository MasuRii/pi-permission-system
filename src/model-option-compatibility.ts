import {
  getApiProvider,
  type Api,
  type AssistantMessageEventStream,
  type Context as LlmContext,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const GUARDED_TEMPERATURE_APIS = [
  "openai-codex-responses",
  "openai-responses",
  "azure-openai-responses",
] as const satisfies readonly Api[];
const OPENAI_RESPONSES_APIS = new Set<Api>([
  "openai-responses",
  "azure-openai-responses",
]);
const TEMPERATURE_UNSUPPORTED_APIS = new Set<Api>([
  "openai-codex-responses",
]);
const TEMPERATURE_UNSUPPORTED_PROVIDERS = new Set<string>([
  "openai-codex",
]);

export type ApiStreamSimpleDelegate = (
  model: Model<Api>,
  context: LlmContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

type GlobalWithPermissionSystemProviderGuard = typeof globalThis & {
  __piPermissionSystemModelOptionBaseStreams?: Map<string, ApiStreamSimpleDelegate>;
  __piPermissionSystemModelOptionGuardedApis?: Set<string>;
};

function getBaseApiStreams(): Map<string, ApiStreamSimpleDelegate> {
  const globalScope = globalThis as GlobalWithPermissionSystemProviderGuard;
  if (!globalScope.__piPermissionSystemModelOptionBaseStreams) {
    globalScope.__piPermissionSystemModelOptionBaseStreams = new Map<string, ApiStreamSimpleDelegate>();
  }
  return globalScope.__piPermissionSystemModelOptionBaseStreams;
}

function getGuardedApis(): Set<string> {
  const globalScope = globalThis as GlobalWithPermissionSystemProviderGuard;
  if (!globalScope.__piPermissionSystemModelOptionGuardedApis) {
    globalScope.__piPermissionSystemModelOptionGuardedApis = new Set<string>();
  }
  return globalScope.__piPermissionSystemModelOptionGuardedApis;
}

function normalizeIdentifier(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function hasModelToken(modelId: string, token: string): boolean {
  return normalizeIdentifier(modelId).split(/[^a-z0-9]+/).includes(token);
}

export function getUnsupportedTemperatureReason(
  model: Pick<Model<Api>, "api" | "id" | "provider" | "reasoning">,
): string | undefined {
  if (TEMPERATURE_UNSUPPORTED_APIS.has(model.api)) {
    return `api '${model.api}' does not support temperature`;
  }

  const provider = normalizeIdentifier(model.provider);
  if (TEMPERATURE_UNSUPPORTED_PROVIDERS.has(provider)) {
    return `provider '${model.provider}' does not support temperature`;
  }

  if (OPENAI_RESPONSES_APIS.has(model.api) && hasModelToken(model.id, "codex")) {
    return `model '${model.id}' does not support temperature`;
  }

  if (OPENAI_RESPONSES_APIS.has(model.api) && model.reasoning) {
    return `reasoning model '${model.id}' accepts only the provider default temperature`;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stripUnsupportedTemperatureFromPayload(payload: unknown): unknown {
  if (!isRecord(payload) || !("temperature" in payload)) {
    return payload;
  }

  const { temperature: _temperature, ...rest } = payload;
  return rest;
}

function composeTemperatureSanitizer(
  options: SimpleStreamOptions | undefined,
  model: Model<Api>,
): SimpleStreamOptions | undefined {
  const reason = getUnsupportedTemperatureReason(model);
  if (!reason && options?.temperature === undefined) {
    return options;
  }

  if (!reason) {
    return options;
  }

  const existingOnPayload = options?.onPayload;
  const nextOptions: SimpleStreamOptions = options
    ? { ...options, temperature: undefined }
    : {};

  nextOptions.onPayload = async (payload, payloadModel) => {
    const transformedPayload = existingOnPayload
      ? await existingOnPayload(payload, payloadModel)
      : undefined;
    return stripUnsupportedTemperatureFromPayload(transformedPayload ?? payload);
  };

  return nextOptions;
}

function ensureModelOptionGuardForApi(pi: ExtensionAPI, api: Api): boolean {
  const guardedApis = getGuardedApis();
  if (guardedApis.has(api)) {
    return true;
  }

  const baseStreams = getBaseApiStreams();
  let baseStream = baseStreams.get(api);
  if (!baseStream) {
    const currentProvider = getApiProvider(api);
    if (!currentProvider) {
      return false;
    }
    baseStream = currentProvider.streamSimple as ApiStreamSimpleDelegate;
    baseStreams.set(api, baseStream);
  }

  const providerName = `pi-permission-system-model-option-compatibility-${api.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  if (!pi.registerProvider) {
    return false;
  }

  pi.registerProvider(providerName, {
    api,
    streamSimple: (model: Model<Api>, context: LlmContext, options?: SimpleStreamOptions) => {
      const delegate = baseStreams.get(model.api);
      if (!delegate) {
        throw new Error(`No base stream provider available for api '${model.api}'.`);
      }

      return delegate(model, context, composeTemperatureSanitizer(options, model));
    },
  });

  guardedApis.add(api);
  return true;
}

export function registerModelOptionCompatibilityGuard(pi: ExtensionAPI): void {
  for (const api of GUARDED_TEMPERATURE_APIS) {
    ensureModelOptionGuardForApi(pi, api);
  }
}
