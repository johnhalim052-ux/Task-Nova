import crypto from 'node:crypto';

export class PaymentProviderConfigError extends Error {
  statusCode = 503;
  provider: string;
  requirements: string[];

  constructor(provider: string, message: string, requirements: string[]) {
    super(message);
    this.name = 'PaymentProviderConfigError';
    this.provider = provider;
    this.requirements = requirements;
  }
}

export class PaymentProviderExecutionError extends Error {
  statusCode = 502;
  provider: string;

  constructor(provider: string, message: string) {
    super(message);
    this.name = 'PaymentProviderExecutionError';
    this.provider = provider;
  }
}

export interface ProviderReadiness {
  method: 'paypal' | 'usdt' | 'vodafone_cash';
  label: string;
  configured: boolean;
  environment: string;
  requiredCredentials: string[];
  complianceNotes: string[];
}

export interface PayoutExecutionInput {
  withdrawalId: number;
  method: 'paypal' | 'usdt' | 'vodafone_cash';
  destinationAccount: string;
  netAmountCents: number;
  recipientEmail: string;
}

export interface PayoutExecutionResult {
  providerName: string;
  providerReference: string;
  rawStatus: string;
}

function getPayPalBaseUrl(): string {
  const env = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase();
  return env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

export function getPaymentProvidersStatus(): ProviderReadiness[] {
  const paypalConfigured = Boolean(
    process.env.PAYPAL_CLIENT_ID?.trim() && process.env.PAYPAL_CLIENT_SECRET?.trim()
  );
  const usdtConfigured = Boolean(
    process.env.USDT_API_URL?.trim() &&
      process.env.USDT_API_KEY?.trim() &&
      process.env.USDT_WALLET_ID?.trim()
  );
  const vodafoneConfigured = Boolean(
    process.env.VODAFONE_CASH_API_URL?.trim() &&
      process.env.VODAFONE_CASH_MERCHANT_ID?.trim() &&
      process.env.VODAFONE_CASH_API_KEY?.trim() &&
      process.env.VODAFONE_CASH_HMAC_SECRET?.trim()
  );

  return [
    {
      method: 'paypal',
      label: 'PayPal Payouts & Checkout',
      configured: paypalConfigured,
      environment: process.env.PAYPAL_ENV || 'sandbox',
      requiredCredentials: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_ENV'],
      complianceNotes: [
        'Requires PayPal Business Account with Payouts API enabled by PayPal Risk/Compliance.',
        'Employer card/PayPal funding requires live PayPal REST app approval & webhook verification.',
      ],
    },
    {
      method: 'usdt',
      label: `USDT Treasury (${process.env.USDT_NETWORK || 'TRC20'})`,
      configured: usdtConfigured,
      environment: process.env.USDT_NETWORK || 'TRC20',
      requiredCredentials: ['USDT_API_URL', 'USDT_API_KEY', 'USDT_WALLET_ID', 'USDT_NETWORK'],
      complianceNotes: [
        'Requires licensed custodial crypto payout provider (e.g. Fireblocks, Circle, Coinbase Prime, or NOWPayments Custody).',
        'Requires AML/sanctions screening and VASP licensing depending on operating jurisdiction.',
      ],
    },
    {
      method: 'vodafone_cash',
      label: 'Vodafone Cash (EGP Wallet Disbursement)',
      configured: vodafoneConfigured,
      environment: 'merchant-api',
      requiredCredentials: [
        'VODAFONE_CASH_API_URL',
        'VODAFONE_CASH_MERCHANT_ID',
        'VODAFONE_CASH_API_KEY',
        'VODAFONE_CASH_HMAC_SECRET',
      ],
      complianceNotes: [
        'Requires Vodafone Egypt Business onboarding or licensed local PSP aggregator (e.g. Paymob, Fawry, Kashier).',
        'Requires Egyptian commercial registration, tax ID, and Central Bank of Egypt e-wallet settlement compliance.',
      ],
    },
  ];
}

export function validateWithdrawalDestination(method: string, destination: string): string | null {
  const value = destination.trim();
  if (method === 'paypal') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(value) ? null : 'Enter a valid PayPal account email address.';
  }
  if (method === 'usdt') {
    const isTrc20 = /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value);
    const isErc20 = /^0x[a-fA-F0-9]{40}$/.test(value);
    return isTrc20 || isErc20
      ? null
      : 'Enter a valid USDT TRC20 (T...) or ERC20 (0x...) wallet address.';
  }
  if (method === 'vodafone_cash') {
    const egPhone = /^01[0125][0-9]{8}$/.test(value);
    return egPhone ? null : 'Enter a valid 11-digit Egyptian Vodafone Cash wallet number (010/011/012/015).';
  }
  return 'Unsupported withdrawal method.';
}

async function getPayPalAccessToken(): Promise<string> {
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new PaymentProviderConfigError(
      'paypal',
      'PayPal credentials are not configured. Real payouts cannot execute without PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.',
      ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PayPal Payouts API Business Approval']
    );
  }

  const baseUrl = getPayPalBaseUrl();
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new PaymentProviderExecutionError('paypal', `PayPal OAuth failed (${response.status}): ${errText.slice(0, 200)}`);
  }

  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new PaymentProviderExecutionError('paypal', 'PayPal OAuth response omitted access_token.');
  }
  return data.access_token;
}

export async function createPayPalEmployerOrder(amountCents: number, employerId: number, returnUrl: string, cancelUrl: string) {
  const token = await getPayPalAccessToken();
  const baseUrl = getPayPalBaseUrl();
  const amountUsd = (amountCents / 100).toFixed(2);

  const response = await fetch(`${baseUrl}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': `tn-emp-${employerId}-${Date.now()}`,
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: `employer_${employerId}`,
          description: 'TaskNova Employer Campaign Funding',
          amount: {
            currency_code: 'USD',
            value: amountUsd,
          },
        },
      ],
      application_context: {
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new PaymentProviderExecutionError('paypal', `PayPal order creation failed (${response.status}): ${errText.slice(0, 200)}`);
  }

  return response.json();
}

export async function capturePayPalEmployerOrder(orderId: string) {
  const token = await getPayPalAccessToken();
  const baseUrl = getPayPalBaseUrl();

  const response = await fetch(`${baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new PaymentProviderExecutionError('paypal', `PayPal order capture failed (${response.status}): ${errText.slice(0, 200)}`);
  }

  return response.json();
}

export async function executeRealProviderPayout(input: PayoutExecutionInput): Promise<PayoutExecutionResult> {
  if (input.method === 'paypal') {
    const token = await getPayPalAccessToken();
    const baseUrl = getPayPalBaseUrl();
    const amountUsd = (input.netAmountCents / 100).toFixed(2);

    const response = await fetch(`${baseUrl}/v1/payments/payouts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender_batch_header: {
          sender_batch_id: `tasknova_wd_${input.withdrawalId}_${Date.now()}`,
          email_subject: 'You have received a TaskNova payout',
          email_message: 'Your verified TaskNova microtask earnings payout has been dispatched.',
        },
        items: [
          {
            recipient_type: 'EMAIL',
            amount: {
              value: amountUsd,
              currency: 'USD',
            },
            note: `TaskNova Withdrawal #${input.withdrawalId}`,
            sender_item_id: `wd_${input.withdrawalId}`,
            receiver: input.destinationAccount,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new PaymentProviderExecutionError('paypal', `PayPal payout rejected (${response.status}): ${errText.slice(0, 240)}`);
    }

    const payload = (await response.json()) as {
      batch_header?: { payout_batch_id?: string; batch_status?: string };
    };
    const batchId = payload.batch_header?.payout_batch_id;
    if (!batchId) {
      throw new PaymentProviderExecutionError('paypal', 'PayPal payout response missing payout_batch_id.');
    }

    return {
      providerName: 'PayPal Payouts API',
      providerReference: batchId,
      rawStatus: payload.batch_header?.batch_status || 'PENDING',
    };
  }

  if (input.method === 'usdt') {
    const apiUrl = process.env.USDT_API_URL?.trim();
    const apiKey = process.env.USDT_API_KEY?.trim();
    const walletId = process.env.USDT_WALLET_ID?.trim();
    const network = process.env.USDT_NETWORK?.trim() || 'TRC20';

    if (!apiUrl || !apiKey || !walletId) {
      throw new PaymentProviderConfigError(
        'usdt',
        'USDT custodial treasury credentials are not configured. Real on-chain payouts cannot be simulated.',
        ['USDT_API_URL', 'USDT_API_KEY', 'USDT_WALLET_ID', 'USDT_NETWORK', 'Custodial VASP KYC/AML Approval']
      );
    }

    const response = await fetch(`${apiUrl.replace(/\/$/, '')}/payouts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `tasknova-usdt-wd-${input.withdrawalId}`,
      },
      body: JSON.stringify({
        walletId,
        asset: 'USDT',
        network,
        destinationAddress: input.destinationAccount,
        amountUsd: (input.netAmountCents / 100).toFixed(2),
        reference: `tasknova_wd_${input.withdrawalId}`,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new PaymentProviderExecutionError('usdt', `USDT gateway rejected payout (${response.status}): ${errText.slice(0, 240)}`);
    }

    const payload = (await response.json()) as { transactionId?: string; txHash?: string; status?: string };
    const ref = payload.txHash || payload.transactionId;
    if (!ref) {
      throw new PaymentProviderExecutionError('usdt', 'USDT gateway response missing transaction reference.');
    }

    return {
      providerName: `USDT Treasury (${network})`,
      providerReference: ref,
      rawStatus: payload.status || 'SUBMITTED',
    };
  }

  if (input.method === 'vodafone_cash') {
    const apiUrl = process.env.VODAFONE_CASH_API_URL?.trim();
    const merchantId = process.env.VODAFONE_CASH_MERCHANT_ID?.trim();
    const apiKey = process.env.VODAFONE_CASH_API_KEY?.trim();
    const hmacSecret = process.env.VODAFONE_CASH_HMAC_SECRET?.trim();

    if (!apiUrl || !merchantId || !apiKey || !hmacSecret) {
      throw new PaymentProviderConfigError(
        'vodafone_cash',
        'Vodafone Cash merchant/PSP aggregator credentials are not configured. Real disbursements require licensed PSP integration.',
        [
          'VODAFONE_CASH_API_URL',
          'VODAFONE_CASH_MERCHANT_ID',
          'VODAFONE_CASH_API_KEY',
          'VODAFONE_CASH_HMAC_SECRET',
          'Vodafone Business / Egyptian PSP Onboarding',
        ]
      );
    }

    const requestBody = JSON.stringify({
      merchantId,
      msisdn: input.destinationAccount,
      amountUsdCents: input.netAmountCents,
      reference: `tasknova_wd_${input.withdrawalId}`,
    });
    const signature = crypto.createHmac('sha256', hmacSecret).update(requestBody).digest('hex');

    const response = await fetch(`${apiUrl.replace(/\/$/, '')}/disbursements`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-TaskNova-Signature': signature,
      },
      body: requestBody,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new PaymentProviderExecutionError(
        'vodafone_cash',
        `Vodafone Cash PSP rejected disbursement (${response.status}): ${errText.slice(0, 240)}`
      );
    }

    const payload = (await response.json()) as { disbursementId?: string; reference?: string; status?: string };
    const ref = payload.disbursementId || payload.reference;
    if (!ref) {
      throw new PaymentProviderExecutionError('vodafone_cash', 'Vodafone Cash PSP response missing disbursementId.');
    }

    return {
      providerName: 'Vodafone Cash PSP',
      providerReference: ref,
      rawStatus: payload.status || 'SUBMITTED',
    };
  }

  throw new PaymentProviderExecutionError('unknown', 'Unsupported payment method.');
}
