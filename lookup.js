const DHT = require('bittorrent-dht')
const ed = require('ed25519-supercop')
const sha1 = require('simple-sha1')
const bencode = require('bencode')
const EventEmitter = require('events').EventEmitter

const BTPK_PREFIX = 'urn:btpk:'
// const BITH_PREFIX = 'urn:btih:'
const checkHash = new RegExp('^[a-fA-F0-9]{40}$')
function encodeSigData (msg) {
  const ref = { seq: msg.seq, v: msg.v }
  if (msg.salt) ref.salt = msg.salt
  return bencode.encode(ref).slice(1, -1)
}

let dht = null
let readyAndNotBusy = null
let check = null

async function keepData(self){
  readyAndNotBusy = false
  for(let i = 0;i < self.properties.length;i++){
    await new Promise((resolve, reject) => {
      self.current(self.properties[i], (error, data) => {
        if(error){
          reject(error)
        } else {
          resolve(data)
        }
      })
    })
  }
  readyAndNotBusy = true
  setTimeout(() => {if(readyAndNotBusy){keepData(self).catch(error => {self.emit('error', error)})}}, 1800000)
}

class WebProperty extends EventEmitter {
  constructor (opt) {
    super()
    if(!opt){
      opt = {}
      opt.dht = dht = new DHT({verify: ed.verify})
      opt.check = false
    } else {
      if(!opt.dht){
        opt.dht = new DHT({verify: ed.verify})
      }
      if(!opt.check){
        opt.check = false
      }
    }
    dht = opt.dht
    check = opt.check
    readyAndNotBusy = true
    if(check){
      this.properties = []
      keepData(this).catch(error => {this.emit('error', error)})
    }
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

    sha1(addressKey, (targetID) => {
      dht.get(targetID, (err, res) => {
        if(err){
          return callback(err)
        } else if(res){

          if(!Buffer.isBuffer(res.v) || !checkHash.test(res.v.toString('utf-8')) || typeof(res.seq) !== 'number'){
            return callback(new Error('data has invalid values'))
          } else {
            const main = {magnet: `magnet:?xs=${BTPK_PREFIX}${address}`, address, infoHash: res.v.toString('hex'), sequence: res.seq, active: true, signed: false, sig: res.sig.toString('hex')}
            if(check){
              if(!this.properties.includes(main.address)){
                this.properties.push(main.address)
              }
            }
            return callback(null, {...main, id: res.id.toString('hex')})
          }
        } else if(!res){
          return callback(new Error('Could not resolve address'))
        }
      })
    })
  }

  publish (keypair, infoHash, sequence, callback) {

    if (!callback) {
      callback = () => noop
    }
    if(!infoHash || typeof(infoHash) !== 'string'){
      return callback(new Error('must have infoHash'))
    }
    if(!sequence || typeof(sequence) !== 'number'){
      sequence = 0
    }
    if((!keypair) || (!keypair.address || !keypair.secret)){
      keypair = this.createKeypair(false)
    }

    const buffAddKey = Buffer.from(keypair.address, 'hex')
    const buffSecKey = Buffer.from(keypair.secret, 'hex')
    const v = infoHash
    const seq = sequence
    const sig = ed.sign(encodeSigData({seq, v}), buffAddKey, buffSecKey)

    dht.put({k: buffAddKey, v, seq, sig}, (putErr, hash, number) => {
      if(putErr){
        return callback(putErr)
      } else {
        const main = {magnet: `magnet:?xs=${BTPK_PREFIX}${keypair.address}`, address: keypair.address, infoHash, sequence, active: true, signed: true, sig: sig.toString('hex')}
        if(check){
          if(!this.properties.includes(main.address)){
            this.properties.push(main.address)
          }
        }
        return callback(null, {...main, hash, number})
      }
    })
  }

  current(address, callback){
    if (!callback) {
      callback = () => noop
    }

    const buffAddKey = Buffer.from(address, 'hex')

    sha1(buffAddKey, (targetID) => {

      dht.get(targetID, (getErr, getData) => {
        if (getErr) {
          return callback(getErr)
        } else if(getData){
          dht.put(getData, (putErr, hash, number) => {
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
        this.emit('error', error)
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
        this.emit('error', error)
        return ''
      }
    } else {
      return link
    }
  }
}

module.exports = {WebProperty, verify: ed.verify}

function noop () {}
