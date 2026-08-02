export const HARNESS_IDS = ["omp"] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

export type HarnessDescriptor = {
  id: HarnessId;
  label: string;
  adapterDirectory: string;
  entrypoints: string[];
  configuration: string;
};

export const HARNESS_DESCRIPTORS: readonly HarnessDescriptor[] = [
  {
    id: "omp",
    label: "Oh My Pi",
    adapterDirectory: "solarisael-house-omp",
    entrypoints: ["index.ts", "hygiene.ts"],
    configuration: "omp-extension-list",
  },
];

export function selectHarnesses(values: readonly string[]): HarnessId[] {
  const requested = values.length > 0 ? values : ["omp"];
  const selected = new Set<HarnessId>();
  for (const value of requested) {
    if (!HARNESS_IDS.includes(value as HarnessId)) {
      throw new Error(`unsupported harness: ${value}; available: ${HARNESS_IDS.join(", ")}`);
    }
    selected.add(value as HarnessId);
  }
  return [...selected];
}
