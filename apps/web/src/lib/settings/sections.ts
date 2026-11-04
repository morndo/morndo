import { CONNECTION_WORDS } from "@morndo/protocol";

export type SettingsSection = { id: string; label: string; href: string };

export function settingsSections(flags: { engines: boolean; updates: boolean }): SettingsSection[] {
  const list: SettingsSection[] = [{ id: "accounts", label: "Accounts", href: "/settings/accounts" }];
  if (flags.engines) list.push({ id: "connections", label: CONNECTION_WORDS.title, href: "/settings/connections" });
  list.push({ id: "devices", label: "Devices", href: "/settings/devices" });
  if (flags.updates) list.push({ id: "updates", label: "Updates", href: "/settings/updates" });
  return list;
}

export function sectionFromPath(pathname: string): string | null {
  const m = /^\/settings\/([^/]+)/.exec(pathname);
  return m?.[1] ?? null;
}

export function isSettingsIndex(pathname: string): boolean {
  return pathname === "/settings" || pathname === "/settings/";
}
