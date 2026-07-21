export const WEB3FORMS_ACCESS_KEY = '9650ee0d-81c2-4edb-9cab-69920938f8ab';

export const WEB3FORMS_ENDPOINT = 'https://api.web3forms.com/submit';

export async function submitWeb3Form(payload: Record<string, string>) {
  const response = await fetch(WEB3FORMS_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      access_key: WEB3FORMS_ACCESS_KEY,
      ...payload,
    }),
  });

  const result = (await response.json()) as { success?: boolean; message?: string };
  if (!response.ok || !result.success) {
    throw new Error(result.message ?? 'Newsletter signup failed');
  }

  return result;
}
