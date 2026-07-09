import { describe, expect, test } from "bun:test";

import { REMEMBER_STORES, buildStoreArgs } from "../solarisael-house-proof/stores.ts";

describe("remember store registry", () => {
  test("exposes actionable metadata for every registered store", () => {
    for (const [kind, store] of Object.entries(REMEMBER_STORES)) {
      expect(kind).not.toBe("");
      expect(store.script).toMatch(/\.py$/);
      expect(store.whenToUse.trim()).not.toBe("");
      expect(Array.isArray(store.required)).toBe(true);
      expect(typeof store.argMap).toBe("object");
      expect(store.argMap).not.toBeNull();
      expect(typeof store.noBackup).toBe("boolean");

      for (const required of store.required) {
        expect(Object.keys(store.argMap)).toContain(required);
      }

      for (const [field, flag] of Object.entries(store.argMap)) {
        expect(field).not.toBe("");
        expect(flag).toMatch(/^--[a-z][a-z-]*$/);
      }
    }
  });
});

describe("buildStoreArgs", () => {
  test("builds argv with repeated tag flags for accepted coding lesson fields", () => {
    const result = buildStoreArgs("coding-lesson", REMEMBER_STORES["coding-lesson"], {
      shape: "process",
      voice: "Kodo",
      proofPattern: "pin observable behavior",
      tags: ["routing", "recall"],
    });

    expect(result).toEqual({
      ok: true,
      args: [
        "--shape",
        "process",
        "--voice",
        "Kodo",
        "--proof-pattern",
        "pin observable behavior",
        "--tag",
        "routing",
        "--tag",
        "recall",
      ],
    });
  });

  test("refuses unknown fields and names the accepted field set", () => {
    const result = buildStoreArgs("project-lesson", REMEMBER_STORES["project-lesson"], {
      project: "solarisael-house",
      alien: "not part of this script interface",
    });

    expect(result).toEqual({
      ok: false,
      error: "kind 'project-lesson' does not accept field 'alien'; accepted: project, proofPattern, triggerContext, tags",
    });
  });

  test("requires project lessons to name a non-empty project", () => {
    const result = buildStoreArgs("project-lesson", REMEMBER_STORES["project-lesson"], {
      project: "",
      tags: [],
    });

    expect(result).toEqual({
      ok: false,
      error: "kind 'project-lesson' requires field 'project'",
    });
  });

  test("treats empty optional strings and arrays as absent", () => {
    const result = buildStoreArgs("coding-lesson", REMEMBER_STORES["coding-lesson"], {
      shape: "",
      voice: "Kodo",
      tags: [],
      triggerContext: null,
      scope: undefined,
    });

    expect(result).toEqual({
      ok: true,
      args: ["--voice", "Kodo"],
    });
  });
});
