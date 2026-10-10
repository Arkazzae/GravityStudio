export type MailProviderId = "smtp" | "resend" | "cloudflare";
export interface MailConfiguration {
  provider: MailProviderId;
  fromEmail: string;
  fromName?: string;
  /** Required only for a custom SMTP server. Cloudflare uses its fixed SMTP endpoint. */
  smtp?: { host: string; port: number; security: "tls" | "starttls"; username: string };
}
export interface MailSettingsView {
  revision: number;
  configuration: MailConfiguration | null;
  /** Secret values and password suffixes are never returned. */
  credentials: Record<MailProviderId, { configured: boolean; updatedAt?: string }>;
}
export interface SaveMailSettings {
  revision: number;
  configuration: MailConfiguration | null;
  /** Omit to preserve the secret; null removes it. Changing SMTP destination clears it. */
  secret?: string | null;
}
/** Accepted by the provider; this does not confirm delivery to the recipient's inbox. */
export interface MailSendResult { provider: MailProviderId; messageId?: string }
