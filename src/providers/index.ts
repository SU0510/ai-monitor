import { ref } from "vue";
import type { Provider } from "./types";
import { deepseekProvider } from "./deepseek";
import { moonshotProvider } from "./moonshot";
import { siliconflowProvider } from "./siliconflow";
import { openrouterProvider } from "./openrouter";
import { openaiProvider } from "./openai";
import { anthropicProvider } from "./anthropic";
import { geminiProvider } from "./gemini";
import { alibabaBailianProvider } from "./alibaba";
import { volcanoArkProvider } from "./volcano";
import { baiduQianfanProvider } from "./baidu";
import { zhipuProvider } from "./zhipu";
import { buildCustomProvider, CUSTOM_PREFIX } from "./custom";
import {
  loadCustomConfigs,
  saveCustomConfigs,
  type CustomApiConfig,
} from "../core/customApi";

/**
 * 已注册的 Provider 列表（新增平台在这里登记）
 * 自动查询优先展示：DeepSeek / Kimi / SiliconFlow / OpenRouter
 */
const builtInProviders: Provider[] = [
  // —— 官方余额接口（自动查询）——
  deepseekProvider,
  moonshotProvider,
  siliconflowProvider,
  openrouterProvider,
  // —— 手动登记模式 ——
  zhipuProvider,
  openaiProvider,
  anthropicProvider,
  geminiProvider,
  alibabaBailianProvider,
  volcanoArkProvider,
  baiduQianfanProvider,
];

/** 已注册的 Provider 列表（内置 + 自定义），响应式以便下拉框实时刷新 */
export const providers = ref<Provider[]>([...builtInProviders]);

/** 已加载的自定义 API 配置（与 providers 保持同步） */
export const customConfigs = ref<CustomApiConfig[]>([]);

export function getProvider(id: string): Provider | undefined {
  return providers.value.find((p) => p.id === id);
}

export function getCustomConfig(id: string): CustomApiConfig | undefined {
  if (!id.startsWith(CUSTOM_PREFIX)) return undefined;
  return customConfigs.value.find((c) => c.id === id.slice(CUSTOM_PREFIX.length));
}

/** 重新加载自定义配置并重建 providers；返回当前自定义 provider 列表 */
export async function syncCustomProviders(): Promise<Provider[]> {
  customConfigs.value = await loadCustomConfigs();
  const built = customConfigs.value.map(buildCustomProvider);
  providers.value = [...builtInProviders, ...built];
  return built;
}

/** 供管理面板读取/写入自定义配置 */
export async function listCustomConfigs(): Promise<CustomApiConfig[]> {
  customConfigs.value = await loadCustomConfigs();
  return customConfigs.value;
}

export async function upsertCustomConfig(cfg: CustomApiConfig): Promise<void> {
  const idx = customConfigs.value.findIndex((c) => c.id === cfg.id);
  if (idx >= 0) customConfigs.value[idx] = cfg;
  else customConfigs.value.push(cfg);
  await saveCustomConfigs(customConfigs.value);
  await syncCustomProviders();
}

export async function deleteCustomConfig(id: string): Promise<void> {
  customConfigs.value = customConfigs.value.filter((c) => c.id !== id);
  await saveCustomConfigs(customConfigs.value);
  await syncCustomProviders();
}
