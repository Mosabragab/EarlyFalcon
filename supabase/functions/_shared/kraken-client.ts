import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts"

export interface KrakenConfig {
  apiKey: string
  apiSecret: string
}

export class KrakenClient {
  private apiKey: string
  private apiSecret: string
  private baseUrl = 'https://api.kraken.com'

  constructor(config: KrakenConfig) {
    this.apiKey = config.apiKey
    this.apiSecret = config.apiSecret
  }

  private createSignature(path: string, postData: string, nonce: number): string {
    const message = path + createHmac('sha256', nonce + postData).digest()
    const hmac = createHmac('sha512', Buffer.from(this.apiSecret, 'base64'))
    hmac.update(message)
    return hmac.digest('base64')
  }

  async publicRequest(endpoint: string, params: Record<string, any> = {}) {
    const url = new URL(`${this.baseUrl}/0/public/${endpoint}`)
    Object.keys(params).forEach(key => url.searchParams.append(key, params[key]))
    
    const response = await fetch(url.toString())
    return await response.json()
  }

  async privateRequest(endpoint: string, params: Record<string, any> = {}) {
    const nonce = Date.now() * 1000
    const postData = new URLSearchParams({ nonce: nonce.toString(), ...params }).toString()
    const path = `/0/private/${endpoint}`
    
    const signature = this.createSignature(path, postData, nonce)
    
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'API-Key': this.apiKey,
        'API-Sign': signature,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: postData
    })
    
    return await response.json()
  }

  async getOHLC(pair: string, interval = 15) {
    return await this.publicRequest('OHLC', { pair, interval })
  }

  async getTicker(pair: string) {
    return await this.publicRequest('Ticker', { pair })
  }

  async addOrder(params: {
    pair: string
    type: 'buy' | 'sell'
    ordertype: 'market' | 'limit'
    volume: string
    price?: string
  }) {
    return await this.privateRequest('AddOrder', params)
  }

  async cancelOrder(txid: string) {
    return await this.privateRequest('CancelOrder', { txid })
  }
}
