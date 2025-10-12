import { DateTime } from "luxon";
import { CONFIG } from "./config";

export function nowEt() {
  return DateTime.now().setZone(CONFIG.etTz);
}

export function todayEtIso(): string {
  return nowEt().toISODate()!;
}
