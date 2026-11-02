import { describe, expect, it } from "vitest";
import { settingsSections, sectionFromPath, isSettingsIndex } from "../src/lib/settings/sections.ts";

describe("settingsSections", () => {
  it("lists Accounts and Devices always, and optional sections when the hub has them", () => {
    expect(settingsSections({ engines: false, updates: false }).map(s => s.label)).toEqual(["Accounts", "Devices"]);
    expect(settingsSections({ engines: true, updates: true }).map(s => s.label)).toEqual([
      "Accounts", "LLM connections", "Devices", "Updates",
    ]);
  });
});

describe("sectionFromPath", () => {
  it("reads the section id from the URL", () => {
    expect(sectionFromPath("/settings/devices")).toBe("devices");
    expect(sectionFromPath("/settings")).toBeNull();
    expect(isSettingsIndex("/settings")).toBe(true);
  });
});
