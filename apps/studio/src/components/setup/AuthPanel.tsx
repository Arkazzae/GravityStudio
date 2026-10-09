'use client';
import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, LoaderCircle } from '@/components/ui/icons';
import { Logo } from '@/components/layout/Logo';
import { api, errorMessage } from '@/lib/api';

export function AuthPanel({ setup, onAuthenticated }: { setup: boolean; onAuthenticated: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [setupKey, setSetupKey] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await api(setup ? '/setup' : '/login', { method: 'POST', body: JSON.stringify({ username, password, ...(setup ? { setupKey } : {}) }) }); onAuthenticated(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <main className="grid min-h-dvh place-items-center overflow-auto px-4 py-8">
    <div className="w-full max-w-[480px] rounded-[28px] border border-white/[0.07] bg-[#151819] p-7 sm:p-[34px]">
      <div className="mb-8 flex items-center gap-2.5 text-[15px] font-medium"><Logo className="size-[29px] text-volt" />Gravity Studio</div>
      <h1 className="text-[30px] font-medium leading-[1.18] tracking-[-.03em]">{setup ? 'Make this studio yours.' : 'Welcome back.'}</h1>
      <p className="mb-7 mt-3 text-[14px] leading-relaxed text-ink-2">{setup ? 'Create the owner account, connect your hardware, and start making images.' : 'Sign in to your studio and pick up where you left off.'}</p>
      <form onSubmit={submit} className="space-y-[18px]">
        {setup && <label className="field">Setup key<input autoComplete="off" type="password" required value={setupKey} onChange={event => setSetupKey(event.target.value)} autoFocus /><span className="text-xs leading-relaxed">Copy the setup key from the server terminal or its <code>setup.key</code> file.</span></label>}
        <label className="field">Username<input name="username" autoComplete="username" required minLength={3} maxLength={64} value={username} onChange={event => setUsername(event.target.value)} autoFocus={!setup} /></label>
        <label className="field">Password<span className="relative"><input className="pr-12!" name="password" type={visible ? 'text' : 'password'} autoComplete={setup ? 'new-password' : 'current-password'} minLength={setup ? 12 : undefined} required value={password} onChange={event => setPassword(event.target.value)} /><button type="button" onClick={() => setVisible(!visible)} aria-label={visible ? 'Hide password' : 'Show password'} className="absolute right-1 top-0 grid h-full w-10 place-items-center">{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button></span>{setup && <span className="text-xs">Use at least 12 characters.</span>}</label>
        {error && <p role="alert" className="error-notice">{error}</p>}
        <button disabled={busy} className="mt-6 flex min-h-[59px] w-full items-center justify-center gap-2 rounded-[15px] bg-volt text-[18px] font-semibold text-on-volt shadow-key transition-colors hover:bg-volt-hi disabled:cursor-wait disabled:bg-volt-busy">{busy && <LoaderCircle className="size-[19px] animate-spin" />}{busy ? 'Connecting…' : setup ? 'Create studio' : 'Sign in'}</button>
      </form>
      <p className="mt-7 text-center text-xs text-ink-2">Your models and images stay on your own server.</p>
    </div>
  </main>;
}
