'use client';

/**
 * Fork. An API-key input that never shows a stored key in clear.
 *
 * Keys live in the browser's own storage, so a page that has just loaded
 * holds the full value -- and every settings page used to offer an eye
 * button that revealed it, to anyone at the screen, indefinitely. DeepWitya
 * shows a stored key as `sk-ab••••wxyz` and asks for a new one to change it;
 * this does the same. The eye only reveals text typed in this session, which
 * the person at the keyboard already knows.
 */

import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';

export function maskApiKey(value: string): string {
  const key = value.trim();
  if (!key) return '';
  if (key.length <= 10) return `${key.slice(0, 2)}••••`;
  return `${key.slice(0, 5)}••••${key.slice(-4)}`;
}

interface ApiKeyFieldProps {
  name: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  onBlur?: () => void;
  className?: string;
}

export function ApiKeyField({
  name,
  value,
  onChange,
  placeholder,
  disabled,
  onBlur,
  className,
}: ApiKeyFieldProps) {
  const { t } = useI18n();
  const [show, setShow] = useState(false);
  // A key the user typed here can be revealed; one that arrived from storage
  // cannot. `typed` flips on the first keystroke and never back.
  const [typed, setTyped] = useState(false);
  const [editing, setEditing] = useState(false);
  const [previous, setPrevious] = useState<string | null>(null);
  // The pages swap providers without remounting their inputs. Reset when the
  // field's identity changes, or a key typed for provider A would leave
  // provider B's stored key revealable.
  const [boundTo, setBoundTo] = useState(name);
  if (boundTo !== name) {
    setBoundTo(name);
    setShow(false);
    setTyped(false);
    setEditing(false);
    setPrevious(null);
  }

  const stored = Boolean(value) && !typed && !editing;

  if (stored) {
    return (
      <div className={cn('flex gap-2', className)}>
        <Input
          name={name}
          type="text"
          readOnly
          disabled={disabled}
          value={maskApiKey(value)}
          className="h-8 flex-1 font-mono text-muted-foreground"
          aria-label={t('settings.apiKeyStored')}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => {
            setPrevious(value);
            setEditing(true);
            onChange('');
          }}
        >
          {t('settings.apiKeyChange')}
        </Button>
      </div>
    );
  }

  return (
    <div className={cn('flex gap-2', className)}>
      <div className="relative flex-1">
        <Input
          name={name}
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={placeholder ?? t('settings.enterApiKey')}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            setTyped(true);
            onChange(e.target.value);
          }}
          onBlur={onBlur}
          className="h-8 pr-8"
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          disabled={disabled}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label={show ? t('settings.apiKeyHide') : t('settings.apiKeyShow')}
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {editing && previous !== null && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            onChange(previous);
            setPrevious(null);
            setEditing(false);
            setTyped(false);
            setShow(false);
            onBlur?.();
          }}
        >
          {t('settings.apiKeyKeep')}
        </Button>
      )}
    </div>
  );
}
