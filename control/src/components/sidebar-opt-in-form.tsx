'use client';

import { type FormEvent, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { SidebarInput } from '@/components/ui/sidebar';
import { submitWeb3Form } from '@/lib/web3forms';

export function SidebarOptInForm() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus('loading');
    setErrorMessage(null);

    try {
      await submitWeb3Form({
        email,
        subject: 'HAR Mission Control newsletter signup',
        message: 'Newsletter subscription from Mission Control',
      });
      setEmail('');
      setStatus('success');
    } catch (error) {
      setStatus('error');
      setErrorMessage(error instanceof Error ? error.message : 'Something went wrong');
    }
  }

  return (
    <Card className="shadow-none">
      <form onSubmit={handleSubmit}>
        <CardHeader className="p-4 pb-0">
          <CardTitle className="text-sm">Subscribe to our newsletter</CardTitle>
          <CardDescription>
            Get HAR harness updates, release notes, and Mission Control news.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2.5 p-4">
          <SidebarInput
            type="email"
            name="email"
            placeholder="Email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              if (status !== 'idle') setStatus('idle');
            }}
            required
            disabled={status === 'loading'}
            autoComplete="email"
          />
          <Button
            type="submit"
            className="w-full bg-sidebar-primary text-sidebar-primary-foreground shadow-none"
            size="sm"
            disabled={status === 'loading'}
          >
            {status === 'loading' ? 'Subscribing…' : 'Subscribe'}
          </Button>
          {status === 'success' ? (
            <p className="text-xs text-muted-foreground">Subscribed — thanks for following along.</p>
          ) : null}
          {status === 'error' ? (
            <p className="text-xs text-destructive">{errorMessage ?? 'Could not subscribe right now.'}</p>
          ) : null}
        </CardContent>
      </form>
    </Card>
  );
}
