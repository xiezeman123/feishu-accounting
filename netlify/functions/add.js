// Netlify Function: /.netlify/functions/add

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
    '日期': Math.floor(now.getTime() / 1000),
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

exports.handler = async function (event, context) {
  const { appId, appSecret, appToken, tableId } = process.env;
  const origin = event.headers.origin || '*';

  // CORS
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    };
  }

  // Health check
  if (event.path.endsWith('/health')) {
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ok' }),
    };
  }

  // Main endpoint
  const params = event.queryStringParameters || {};
  const { amount, category, note } = params;

  if (!amount) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'missing amount' }),
    };
  }

  try {
    const recordId = await addRecord(appId, appSecret, appToken, tableId, amount, category, note);
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ok', record_id: recordId }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
