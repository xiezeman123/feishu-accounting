// Vercel serverless function: https://vercel.com/xiezeman123/feishu-accounting/api

// Re-use token across warm invocations (Vercel keeps instances warm briefly)
let cachedToken = null;
let tokenExpiry = 0;

async function getFeishuToken(appId, appSecret) {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry - 300000) {
    return cachedToken;
  }

  const resp = await fetch(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    }
  );

  const data = await resp.json();
  if (data.code !== 0) throw new Error('Token error: ' + data.msg);

  cachedToken = data.tenant_access_token;
  tokenExpiry = now + (data.expires_in || 7200) * 1000;
  return cachedToken;
}

async function addRecord(appId, appSecret, appToken, tableId, amount, category, note) {
  const token = await getFeishuToken(appId, appSecret);
  const now = new Date();

  const fields = {
    '备注': note || '',
    '分类': category || '其他',
    '时间': now.toTimeString().slice(0, 8),
    '日期': now.toISOString().slice(0, 10),
    '金额': parseFloat(amount) || 0,
  };

  const resp = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    }
  );

  const data = await resp.json();
  if (!resp.ok || data.code !== 0) {
    throw new Error('Bitable error: ' + JSON.stringify(data));
  }
  return data.data?.record?.record_id;
}

module.exports = async function handler(req, res) {
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const { appId, appSecret, appToken, tableId } = process.env;

  if (req.method === 'GET' && req.url.startsWith('/api/add')) {
    const { amount, category, note } = req.query || {};
    if (!amount) {
      return res.status(400).json({ error: 'missing amount' });
    }
    try {
      const recordId = await addRecord(appId, appSecret, appToken, tableId, amount, category, note);
      return res.status(200).json({ status: 'ok', record_id: recordId });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.url === '/api/health') {
    return res.status(200).json({ status: 'ok' });
  }

  return res.status(404).json({ error: 'not found' });
};
