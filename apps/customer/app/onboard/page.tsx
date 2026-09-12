'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserSupabaseClient, normalizeGhanaPhone } from '@pixel-barber/shared';

type Step = 'phone' | 'otp' | 'password';

export default function OnboardPage() {
  const router = useRouter();
  const supabase = createBrowserSupabaseClient();
  const [step, setStep] = useState<Step>('phone');
  const [name, setName] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [normalizedPhone, setNormalizedPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handlePhoneSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const normalized = normalizeGhanaPhone(phoneInput);
    if (!normalized) {
      setError('Enter a valid 10-digit Ghana phone number.');
      return;
    }
    const { error: otpError } = await supabase.auth.signInWithOtp({ phone: normalized });
    if (otpError) {
      setError(otpError.message);
      return;
    }
    setNormalizedPhone(normalized);
    setStep('otp');
  }

  async function handleOtpSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { error: verifyError } = await supabase.auth.verifyOtp({
      phone: normalizedPhone,
      token: otp,
      type: 'sms',
    });
    if (verifyError) {
      setError(verifyError.message);
      return;
    }
    setStep('password');
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError(updateError.message);
      return;
    }
    const { error: linkError } = await supabase.rpc('link_or_create_customer', {
      p_name: name,
    });
    if (linkError) {
      setError(linkError.message);
      return;
    }
    router.push('/tickets');
  }

  return (
    <main>
      <h1>Sign Up</h1>
      {error && <p role="alert">{error}</p>}
      {step === 'phone' && (
        <form onSubmit={handlePhoneSubmit}>
          <input
            placeholder="Full name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <input
            placeholder="0244123456"
            value={phoneInput}
            onChange={(e) => setPhoneInput(e.target.value)}
            required
          />
          <button type="submit">Send Code</button>
        </form>
      )}
      {step === 'otp' && (
        <form onSubmit={handleOtpSubmit}>
          <input
            placeholder="6-digit code"
            value={otp}
            onChange={(e) => setOtp(e.target.value)}
            required
          />
          <button type="submit">Verify</button>
        </form>
      )}
      {step === 'password' && (
        <form onSubmit={handlePasswordSubmit}>
          <input
            type="password"
            placeholder="Set a password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
          <button type="submit">Finish</button>
        </form>
      )}
    </main>
  );
}
