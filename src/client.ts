// Only Hono's client is imported at runtime; server/DB code stays out of app bundles.
import { hc } from "hono/client";
import type { AppType } from "./app";
export type { AppType } from "./app";
export type { ReceivedRequest, ReceivedResponse } from "./contracts";
export type {
  SwitchStatus,
  ProfileResponse,
  MeResponse,
  Recipient,
  Message,
  Delivery,
  BillingAccount,
  SubscriptionsResponse,
  DeviceSession,
  BootstrapResponse,
  CurrentConsent,
  ActivationBlocker,
} from "./responses";
export const createApiClient = (baseUrl: string, options?: Parameters<typeof hc>[1]) =>
  hc<AppType>(baseUrl, options);
