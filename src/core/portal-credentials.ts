import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface PortalCredentials {
  portalUrl: string;
  token: string;
  workspace?: string;
  email?: string;
  createdAt: string;
}

export function portalCredentialsPath(): string {
  if (process.env.HAR_CREDENTIALS_PATH) {
    return path.resolve(process.env.HAR_CREDENTIALS_PATH);
  }
  return path.join(os.homedir(), '.har', 'credentials.json');
}

export function readPortalCredentials(): PortalCredentials | null {
  try {
    const raw = fs.readFileSync(portalCredentialsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PortalCredentials>;
    if (!parsed.portalUrl || !parsed.token) return null;
    return {
      portalUrl: parsed.portalUrl,
      token: parsed.token,
      workspace: parsed.workspace,
      email: parsed.email,
      createdAt: parsed.createdAt ?? '',
    };
  } catch {
    return null;
  }
}

export function writePortalCredentials(creds: PortalCredentials): void {
  const file = portalCredentialsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
