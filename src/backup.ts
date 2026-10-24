import JSZip from "jszip";
import { summarizeDiff } from "./diff.ts";
import type { AppState, DailyEntry, DiffSummary, Version } from "./types.ts";

export const fullBackupJsonPath = "zhuzi-data.json";
export const analysisBackupJsonPath = "analysis/zhuzi-analysis.json";

export type AnalysisVersion = Omit<Version, "diff_from_previous"> & {
  diff_summary: DiffSummary;
};

export type AnalysisEntry = Omit<DailyEntry, "versions"> & {
  versions: AnalysisVersion[];
};

export type AnalysisAppState = Omit<AppState, "entries"> & {
  entries: AnalysisEntry[];
};

export type AnalysisBackupPayload<T extends { state: AppState }> = Omit<T, "state"> & {
  export_profile: "analysis";
  derived_fields_included: {
    diff_summary: true;
    full_diff: false;
  };
  state: AnalysisAppState;
};

export type ImportFile = Blob & {
  name: string;
  type: string;
};

export async function readBackupPayload(file: ImportFile): Promise<unknown> {
  if (isZipBackupFile(file)) {
    const zip = await JSZip.loadAsync(new Uint8Array(await file.arrayBuffer()));
    const candidates = [fullBackupJsonPath, "char300-lab-data.json", analysisBackupJsonPath];
    let parseError: unknown = null;

    for (const path of candidates) {
      const dataFile = zip.file(path);
      if (!dataFile) {
        continue;
      }
      try {
        return JSON.parse(await dataFile.async("string")) as unknown;
      } catch (error) {
        parseError = error;
      }
    }

    if (parseError) {
      throw parseError;
    }
    throw new Error("Backup JSON missing from zip");
  }

  return JSON.parse(await file.text()) as unknown;
}

export function createAnalysisBackupPayload<T extends { state: AppState }>(payload: T): AnalysisBackupPayload<T> {
  return {
    ...payload,
    export_profile: "analysis",
    derived_fields_included: {
      diff_summary: true,
      full_diff: false
    },
    state: {
      ...payload.state,
      entries: payload.state.entries.map((entry) => ({
        ...entry,
        versions: entry.versions.map((version, index, versions) => {
          const { diff_from_previous, ...versionWithoutDiff } = version;
          void diff_from_previous;
          return {
            ...versionWithoutDiff,
            diff_summary: summarizeDiff(versions[index - 1]?.content ?? "", version.content)
          };
        })
      }))
    }
  };
}

export function addBackupJsonFiles<T extends { state: AppState }>(zip: JSZip, payload: T): void {
  zip.file(fullBackupJsonPath, JSON.stringify(payload, null, 2));
  zip.file(analysisBackupJsonPath, JSON.stringify(createAnalysisBackupPayload(payload), null, 2));
}

export async function generateCompressedZip(zip: JSZip): Promise<Blob> {
  return zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 }
  });
}

export function isZipBackupFile(file: Pick<ImportFile, "name" | "type">): boolean {
  return file.name.toLowerCase().endsWith(".zip") || file.type === "application/zip" || file.type === "application/x-zip-compressed";
}

export function hasMarkdownContent(entry: DailyEntry): boolean {
  return entry.versions.length > 0 || Boolean(entry.saved_translation.trim());
}

export function renderSavedTranslationMarkdown(entry: DailyEntry): string {
  return entry.saved_translation.trim()
    ? ["### 本篇已保存译文", "", "可能不对应当前正文。", "", entry.saved_translation, ""].join("\n")
    : "";
}

export function renderEntryMarkdownText(entry: DailyEntry, label: string, versionDescriptions: string[]): string {
  if (!hasMarkdownContent(entry)) return "";
  const first = entry.versions[0];
  const last = entry.versions.at(-1);
  const lines = [`## ${entry.date_key} · ${label}`, ""];
  if (first && last) {
    const summary = summarizeDiff(first.content, last.content);
    const inserted = summary.han.insert + summary.latin.insert + summary.number.insert;
    const deleted = summary.han.delete + summary.latin.delete + summary.number.delete;
    lines.push(`${last.token_stats.total_units}/300`, "", last.content || "空白版本", "",
      `文字 +${inserted} -${deleted} · 标点 +${summary.punctuation.insert} -${summary.punctuation.delete} · 迭代 ${entry.versions.length}`,
      "", "### 版本", "", ...versionDescriptions, "");
  }
  lines.push(renderSavedTranslationMarkdown(entry));
  return lines.join("\n");
}
