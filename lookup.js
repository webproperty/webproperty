const DHT = require('bittorrent-dht')
const sodium = require('sodium-universal')
const sha1 = require('simple-sha1')

const BTPK_PREFIX = 'urn:btpk:'
// const BITH_PREFIX = 'urn:btih:'

function verify (signature, message, address) {
  return sodium.crypto_sign_verify_detached(signature, message, address)
}

function sign (message, address, secret) {
  const signature = Buffer.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(signature, message, secret)
  return signature
}

class WebProperty {
  constructor (dht) {
    if(!dht){
      dht = new DHT({verify})
    } else if(Array.isArray(dht) || typeof(dht) !== 'object'){
      dht = new DHT({verify})
    }
    this.dht = dht
  }

  resolve (address, callback) {
    if(!callback){
      callback = () => noop
    }

    address = this.addressFromLink(address)
    if(!address){
      return callback(new Error('address can not be parsed'))
    }
    const addressKey = Buffer.from(address, 'hex')
    const magnet = `magnet:?xs=${BTPK_PREFIX}${address}`
    const active = true
    const signed = false

    sha1(addressKey, (targetID) => {
      this.dht.get(targetID, (err, res) => {
        if(err){
          return callback(err)
        } else if(res){

          if(!Buffer.isBuffer(res.v) || typeof(res.seq) !== 'number'){
            return callback(new Error('data has invalid values'))
          } else {
            const infoHash = res.v.toString('hex')
            const seq = res.seq
            return callback(null, { magnet, address, infoHash, seq, active, signed })
          }
        } else if(!res){
          return callback(new Error('Could not resolve address'))
        }
      })
    })
  }

  publish (keypair, infoHash, seq, callback) {

    if (!callback) {
      callback = () => noop
    }
    if(!infoHash || typeof(infoHash) !== 'string'){
      return callback(new Error('must have infoHash'))
    }
    if(!seq || typeof(seq) !== 'number'){
      seq = 0
    }
    if((!keypair) || (!keypair.address || !keypair.secret)){
      keypair = this.createKeypair(false)
    }

    const buffAddKey = Buffer.from(keypair.address, 'hex')
    const buffSecKey = Buffer.from(keypair.secret, 'hex')
    const getData = {k: buffAddKey, v: Buffer.from(infoHash, 'hex'), seq, sign: (buf) => {return sign(buf, buffAddKey, buffSecKey)}}
    const magnet = `magnet:?xs=${BTPK_PREFIX}${keypair.address}`
    const active = true
    const signed = true

    this.dht.put(getData, (putErr, hash, number) => {
      if(putErr){
        return callback(putErr)
      } else {
        return callback(null, {magnet, address: keypair.address, infoHash, seq, active, signed, secret: keypair.secret, hash, number})
      }
    })
  }

  current(address, callback){
    if (!callback) {
      callback = () => noop
    }

    const buffAddKey = Buffer.from(address, 'hex')

    sha1(buffAddKey, (targetID) => {

      this.dht.get(targetID, (getErr, getData) => {
        if (getErr) {
          return callback(getErr)
        } else if(getData){
          this.dht.put(getData, (putErr, hash, number) => {
            if(putErr){
              return callback(putErr)
            } else {
              return callback(null, {getData, putData: {hash: hash.toString('hex'), number}})
            }
          })
        } else if(!getData){
          return callback(new Error('did not find property'))
        }
      })
    })
  }

  createKeypair (seed) {
    const addressKey = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
    const secretKey = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES)

    if (seed) {
      sodium.crypto_sign_seed_keypair(addressKey, secretKey, seed)
    } else { sodium.crypto_sign_keypair(addressKey, secretKey) }

    return { address: addressKey.toString('hex'), secret: secretKey.toString('hex') }
  }

  addressFromLink(link){
    if(!link || typeof(link) !== 'string'){
      return ''
    } else if(link.startsWith('bt')){
      try {
        const parsed = new URL(link)
    
        if(!parsed.hostname){
          return ''
        } else {
          return parsed.hostname
        }

      } catch (error) {
        console.log(error)
        return ''
      }
    } else if(link.startsWith('magnet')){
      try {
        const parsed = new URL(link)

        const xs = parsed.searchParams.get('xs')
  
        const isMutableLink = xs && xs.startsWith(BTPK_PREFIX)
    
        if(!isMutableLink){
          return ''
        } else {
          return xs.slice(BTPK_PREFIX.length)
        }

      } catch (error) {
        console.log(error)
        return ''
      }
    } else {
      return link
    }
  }
}

module.exports = {WebProperty, verify}

function noop () {}
