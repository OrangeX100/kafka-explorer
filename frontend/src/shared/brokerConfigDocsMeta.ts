// Shared type + merge point for the broker config dictionaries (A–R in
// brokerConfigDocsAR.ts, S–Z in brokerConfigDocsSZ.ts). English mode skips
// this map and shows the readable key plus the broker's own documentation
// string, so unknown keys never render untranslated either way.
// BROKER_DOC_AR/SZ hold the Chinese translations of the official docs, shown
// as the "官方文档" layer in the edit dialog so both locales carry the same
// information.
export interface BrokerConfigMeta {
  zh: string;
  desc: string;
  doc?: string;
}

import { BROKER_CONFIG_DOCS_AR } from "./brokerConfigDocsAR.js";
import { BROKER_CONFIG_DOCS_SZ } from "./brokerConfigDocsSZ.js";
import { BROKER_DOC_AR } from "./brokerConfigDocsDocAR.js";
import { BROKER_DOC_SZ } from "./brokerConfigDocsDocSZ.js";

const BROKER_DOC: Record<string, string> = { ...BROKER_DOC_AR, ...BROKER_DOC_SZ };

export const BROKER_CONFIG_DOCS: Record<string, BrokerConfigMeta> = {};
for (const [k, base] of [...Object.entries(BROKER_CONFIG_DOCS_AR), ...Object.entries(BROKER_CONFIG_DOCS_SZ)]) {
  const doc = BROKER_DOC[k];
  BROKER_CONFIG_DOCS[k] = doc ? { ...base, doc } : base;
}

export function configMeta(name: string): BrokerConfigMeta | undefined {
  return BROKER_CONFIG_DOCS[name];
}
