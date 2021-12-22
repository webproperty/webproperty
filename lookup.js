const DHT = require('bittorrent-dht')
const ed = require('ed25519-supercop')
const sha1 = require('simple-sha1')
const bencode = require('bencode')
const path = require('path')
const fs = require('fs')
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
let folder = null

async function startUp(self){
  let contents = await new Promise((resolve, reject) => {
    fs.readdir(folder, {withFileTypes: false}, (error, files) => {
      if(error){
        reject(null)
      } else if(files){
        resolve(files)
      } else if(!files){
        reject(null)
      }
    })
  })
  for(let i = 0;i < contents.length;i++){
    let content = await new Promise((resolve, reject) => {
      fs.readFile(folder + path.sep + contents[i], {flag: 'r'}, (error, data) => {
        if(error){
          reject(null)
        } else if(data){
          resolve(JSON.parse(data.toString('utf-8')))
        } else if(!data){
          reject(null)
        }
      })
    })
    if(content){
      if(!self.properties.includes(content.address)){
        self.properties.push(content.address)
      }
    }
  }
  contents = null
  await keepItUpdated(self)
}

async function keepItUpdated(self){
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
  setTimeout(() => {if(readyAndNotBusy){keepItUpdated(self).catch(error => {self.emit('error', error)})}}, 1800000)
}

class WebProperty extends EventEmitter {
  constructor (opt) {
    super()
    if(!opt){
      opt = {}
      opt.dht = dht = new DHT({verify: ed.verify})
      opt.folder = __dirname
    } else {
      if(!opt.dht){
        opt.dht = new DHT({verify: ed.verify})
      }
      if(!opt.folder || typeof(opt.folder) !== 'string'){
        opt.folder = __dirname
      }
    }
    dht = opt.dht
    readyAndNotBusy = true
    folder = path.resolve(path.resolve(opt.folder) + path.sep + 'magnet')
    this.properties = []
    startUp(this).catch(error => {this.emit('error', error)})
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

            try {
              if(!checkHash.test(res.v.ih) || !Number.isInteger(res.seq)){
                throw new Error('data is invalid')
              }
              for(const prop in res.v){
                res.v[prop] = res.v[prop].toString('utf-8')
              }
            } catch (error) {
              return callback(error)
            }
            let {ih, ...stuff} = res.v
            const main = {magnet: `magnet:?xs=${BTPK_PREFIX}${address}`, address, infoHash: ih, sequence: res.seq, active: true, signed: false, sig: res.sig.toString('hex'), stuff}
            if(!this.properties.includes(main.address)){
              this.properties.push(main.address)
            }
            return callback(null, {...main, netdata: res})
        } else if(!res){
          return callback(new Error('Could not resolve address'))
        }
      })
    })
  }

  publish (address, secret, text, sequence, sig, callback) {

    if (!callback) {
      callback = () => noop
    }
    try {
      for(let prop in text){
        if(typeof(text[prop]) !== 'string'){
          throw new Error('text data must be strings')
        }
      }
      if(!checkHash.test(text.ih)){
        throw new Error('must have infohash')
      }
    } catch (error) {
      return callback(error)
    }
    if(!sequence || typeof(sequence) !== 'number'){
      sequence = 0
    }
    if(address){
      return callback(new Error('must have address'))
    }
    if(!sig && !secret){
      return callback(new Error('must have secret or signature'))
    }

    const buffAddKey = Buffer.from(address, 'hex')
    const buffSecKey = secret ? Buffer.from(secret, 'hex') : null
    const v = text
    const seq = sequence
    const buffSig = sig ? Buffer.from(sig, 'hex') : ed.sign(encodeSigData({seq, v}), buffAddKey, buffSecKey)
    // const mainletagnet, address: keypair.address, infoHash, sequence}
    dht.put({k: buffAddKey, v, seq, sig: buffSig}, (putErr, hash, number) => {
      if(putErr){
        return callback(putErr)
      } else {
        let {ih, ...stuff} = text
        let main = {magnet: `magnet:?xs=${BTPK_PREFIX}${address}`, address, infoHash: ih, sequence, active: true, signed: true, sig: buffSig.toString('hex'), stuff}
        fs.writeFile(folder + path.sep + main.address, JSON.stringify(main), error => {
          if(error){
            console.log(error)
          }
          if(!this.properties.includes(main.address)){
            this.properties.push(main.address)
          }
          return callback(null, {...main, netdata: {hash, number}, secret})
        })
      }
    })
  }

  shred(address, callback){
    if (!callback) {
      callback = () => noop
    }
    if(!this.properties.includes(address)){
      return callback(new Error('did not find address'))
    }
    fs.rm(folder + path.sep + address, {recursive: true, force: true}, error => {
      if(error){
        console.log(error)
      }
      this.properties.splice(this.properties.indexOf(address), 1)
      return callback(null, address + ' has been removed')
    })
  }

  bothGetPut(address, callback){
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
              return callback(null, getData, null)
            } else {
              return callback(null, getData, {hash: hash.toString('hex'), number})
            }
          })
        } else if(!getData){
          return callback(new Error('could not find property'))
        }
      })
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

  createKeypair () {
    let {publicKey, secretKey} = ed.createKeyPair(ed.createSeed())

    return { address: publicKey.toString('hex'), secret: secretKey.toString('hex') }
  }

  addressFromLink(link){
    if(!link || typeof(link) !== 'string'){
      return ''
    } else if(link.startsWith('bt') || link.startsWith('bittorrent')){
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
