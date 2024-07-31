import { NextResponse } from "next/server"

export async function GET(request: Request) {
  console.log(request)
  // クライアントのIPアドレスを取得
  const clientIp = request.headers.get("x-client-ip") || "IP not found"
  console.log(clientIp)

  // IPアドレスをJSONでレスポンス
  return NextResponse.json({
    ip: clientIp,
  })
}
