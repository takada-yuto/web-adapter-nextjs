import cf from "cloudfront"
const kvsId = "KVS_ID"
const kvsHandle = cf.kvs(kvsId)

async function handler(event) {
  var request = event.request
  var clientIP = event.viewer.ip
  const allowIps = await kvsHandle.get("allowIps")
  console.log(allowIps)
  console.log(event)
  console.log(clientIP)
  request.headers["x-client-ip"] = { value: clientIP }

  var isPermittedIp = allowIps.includes(clientIP)

  if (isPermittedIp) {
    console.log(request)
    return request
  }
  return {
    statusCode: 403,
    statusDescription: "Forbidden",
  }
}
