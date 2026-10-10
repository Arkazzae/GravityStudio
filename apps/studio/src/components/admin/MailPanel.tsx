'use client';

import { useEffect, useState } from 'react';
import type { MailConfiguration, MailProviderId, MailSettingsView } from '../../../../../packages/contracts/mail';
import { api } from '@/lib/api';
import { button, copy, date, Feedback, Heading, Loading, primary, useAction, useResource } from './shared';

const names = { smtp: 'SMTP', resend: 'Resend', cloudflare: 'Cloudflare Email Sending' };
export function MailPanel() {
  const resource = useResource<MailSettingsView>('/admin/mail');
  const action = useAction();
  const [provider, setProvider] = useState<MailProviderId>('smtp'), [fromEmail, setFromEmail] = useState(''), [fromName, setFromName] = useState('Gravity Studio');
  const [host, setHost] = useState(''), [port, setPort] = useState('465'), [security, setSecurity] = useState<'tls' | 'starttls'>('tls'), [username, setUsername] = useState('');
  const [secret, setSecret] = useState(''), [to, setTo] = useState('');
  useEffect(() => {
    const settings = resource.data?.configuration;
    if (!settings) return;
    setProvider(settings.provider); setFromEmail(settings.fromEmail); setFromName(settings.fromName || ''); setHost(settings.smtp?.host || ''); setPort(String(settings.smtp?.port || 465)); setSecurity(settings.smtp?.security || 'tls'); setUsername(settings.smtp?.username || ''); setSecret('');
  }, [resource.data]);
  const credential = resource.data?.credentials[provider];
  return <section><Heading title="Mail" onRefresh={resource.reload} loading={resource.loading}>Configure how Studio sends invitations. Save a provider, then send a test to an address you choose.</Heading>
    {resource.loading && <Loading>Loading mail settings…</Loading>}<Feedback error={resource.error || action.error} notice={action.notice} />
    {resource.data && <>
      <form className="max-w-[760px]" onSubmit={event => { event.preventDefault(); void action.run(async signal => { const configuration: MailConfiguration = { provider, fromEmail: fromEmail.trim(), ...(fromName.trim() ? { fromName: fromName.trim() } : {}), ...(provider === 'smtp' ? { smtp: { host: host.trim(), port: Number(port), security, username: username.trim() } } : {}) }; await api('/admin/mail', { method: 'PUT', body: JSON.stringify({ revision: resource.data!.revision, configuration, ...(secret ? { secret } : {}) }), signal }); setSecret(''); resource.reload(); action.setNotice('Mail settings saved. Send a test email to check delivery.'); }); }}>
        <fieldset disabled={action.busy} className="grid min-w-0 gap-4 sm:grid-cols-2">
          <label className="field sm:col-span-2">Mail provider<select name="mail-provider" value={provider} onChange={event => { setProvider(event.target.value as MailProviderId); setSecret(''); }}><option value="smtp">SMTP</option><option value="resend">Resend</option><option value="cloudflare">Cloudflare Email Sending</option></select></label>
          <p className={`sm:col-span-2 ${copy}`}>{provider === 'smtp' ? 'Use a TLS-enabled SMTP account from your mail provider.' : provider === 'resend' ? 'Use an API key and a verified sending domain in Resend.' : 'Your domain must be onboarded in Cloudflare Email Sending. Use an API token with Email Sending: Edit permission.'}</p>
          <label className="field">Sender email<input name="mail-from" type="email" required maxLength={254} value={fromEmail} onChange={event => setFromEmail(event.target.value)} placeholder="studio@example.com" /></label>
          <label className="field">Sender name<input name="mail-from-name" maxLength={120} value={fromName} onChange={event => setFromName(event.target.value)} /></label>
          {provider === 'smtp' && <><label className="field sm:col-span-2">SMTP host<input name="smtp-host" required value={host} onChange={event => setHost(event.target.value)} placeholder="smtp.example.com" /></label><label className="field">Port<input name="smtp-port" type="number" min={1} max={65535} required value={port} onChange={event => setPort(event.target.value)} /></label><label className="field">Security<select name="smtp-security" value={security} onChange={event => setSecurity(event.target.value as 'tls' | 'starttls')}><option value="tls">TLS</option><option value="starttls">STARTTLS</option></select></label><label className="field sm:col-span-2">SMTP username<input name="smtp-username" autoComplete="off" required value={username} onChange={event => setUsername(event.target.value)} /></label></>}
          <label className="field sm:col-span-2">{provider === 'smtp' ? 'SMTP password' : 'API token'}<input name="mail-secret" type="password" autoComplete="new-password" value={secret} onChange={event => setSecret(event.target.value)} placeholder={credential?.configured ? 'Leave blank to keep the saved credential' : 'Enter a credential'} /><span className="text-xs leading-relaxed text-ink-2">{credential?.configured ? `Credential saved${credential.updatedAt ? ` · ${date(credential.updatedAt)}` : ''}. It is never returned to the browser.` : 'No credential saved.'}{provider === 'smtp' ? ' Changing the SMTP host or account requires its password again.' : ''}</span></label>
          <div className="flex flex-wrap gap-3 sm:col-span-2"><button disabled={action.busy} className={primary}>{action.busy ? 'Saving…' : 'Save mail settings'}</button>{credential?.configured && <button type="button" disabled={action.busy} className={button} onClick={() => void action.run(async signal => { await api(`/admin/mail/credentials/${provider}`, { method: 'DELETE', body: JSON.stringify({ revision: resource.data!.revision }), signal }); setSecret(''); resource.reload(); action.setNotice(`${names[provider]} credential removed.`); })}>Remove saved credential</button>}</div>
        </fieldset>
      </form>
      <form className="mt-8 max-w-[760px] border-t border-line pt-6" onSubmit={event => { event.preventDefault(); void action.run(async signal => { await api('/admin/mail/test', { method: 'POST', body: JSON.stringify({ to: to.trim() }), signal }); action.setNotice(`Test email sent to ${to.trim()}.`); }); }}><h2 className="text-lg font-medium">Test delivery</h2><p className={`mt-2 ${copy}`}>This sends a real email using your saved configuration.</p><fieldset disabled={action.busy || !resource.data.configuration} className="mt-4 flex flex-wrap items-end gap-3"><label className="field min-w-0 flex-1 basis-60">Recipient<input name="mail-test-to" type="email" required value={to} onChange={event => setTo(event.target.value)} placeholder="you@example.com" /></label><button className={button} disabled={action.busy || !to.trim() || !resource.data.configuration}>Send test email</button></fieldset></form>
      {resource.data.configuration && <div className="mt-8 border-t border-line pt-6"><button type="button" disabled={action.busy} className={button} onClick={() => void action.run(async signal => { await api('/admin/mail', { method: 'PUT', body: JSON.stringify({ revision: resource.data!.revision, configuration: null }), signal }); resource.reload(); action.setNotice('Email delivery disabled. Invitation links can still be created and shared.'); })}>Disable email delivery</button></div>}
    </>}
  </section>;
}
