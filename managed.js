const DHT = require('bittorrent-dht')
const sodium = require('sodium-universal')
const sha1 = require('simple-sha1')
const fs = require('fs')
const EventEmitter = require('events').EventEmitter

const BTPK_PREFIX = 'urn:btpk:'
const BITH_PREFIX = 'urn:btih:'

function verify (signature, message, address) {
  return sodium.crypto_sign_verify_detached(signature, message, address)
}

function sign (message, address, secret) {
  const signature = Buffer.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(signature, message, secret)
  return signature
}

class WebProperty extends EventEmitter {
  constructor (opt) {
    super()
    if(!opt){
      opt = {}
      opt.dht = new DHT({verify})
      opt.takeOutInActive = false
    } else {
      if(typeof(opt) !== 'object' || Array.isArray(opt)){
        opt = {}
      }
      if(!opt.dht){
        opt.dht = new DHT({verify})
      }
      if(!opt.takeOutInActive){
        opt.takeOutInActive = false
      }
    }
    this.dht = opt.dht
    this.database = level('database')
    if(!fs.existsSync('./folder')){
      fs.mkdirSync('./folder', {recursive: true})
    }
    this.folder = path.resolve('./folder')
    this.takeOutInActive = opt.takeOutInActive
    this.readyAndNotBusy = true
    this.properties = []
    // this.checks = []

    this.startUp().catch(error => {
      this.emit('error', error)
    })
  }

  async startUp(){
    for await (const [key, value] of this.database.iterator()){
      this.properties.push(JSON.parse(value))
    }
    await this.keepItUpdated()
  }

  async keepItSaved(){
    let contents = await new Promise((resolve, reject) => {
      fs.readdir(this.folder, {withFileTypes: true}, (error, data) => {
        if(error){
          this.emit('error', error)
          reject(null)
        } else if(!data){
          this.emit('error', new Error('can not find the directory of the properties'))
          reject(null)
        } else if(data){
          resolve(data)
        }
      })
    })
    let tempContents = this.properties.map(data => {return data.address})
    contents = contents.filter(data => {return !tempContents.includes(data)})
    for(let i = 0;i < contents.length;i++){
      await new Promise((resolve, reject) => {
        fs.rm(this.folder + path.sep + contents[i], {force: true}, error => {
          if(error){
            this.emit('error', error)
            reject(false)
          } else {
            resolve(true)
          }
        })
      })
    }
    contents = null
    tempContents = null
    for(let i = 0;i < this.properties.length;i++){
      await new Promise((resolve, reject) => {
        fs.writeFile(this.folder + path.sep + this.properties[i].address, JSON.stringify({address: this.properties[i].address, infoHash: this.properties[i].infoHash, seq: this.properties[i].seq, own: this.properties[i].own, active: this.properties[i].active, magnet: this.properties[i].magnet}), error => {
          if(error){
            this.emit('error', error)
            reject(false)
          } else {
            resolve(true)
          }
        })
      })
    }
    // setTimeout(() => {if(this.readyAndNotBusy){this.keepItSaved().catch(error => {this.emit('error', error)})}}, 1800000)
  }

  async keepItUpdated(){
    this.readyAndNotBusy = false
    this.emit('check', false)
    for(let i = 0;i < this.properties.length;i++){
      let res = await new Promise((resolve, reject) => {
        this.current(this.properties[i].address, (error, data) => {
          if(error){
            this.emit('error', error)
            reject(null)
          } else {
            resolve(data)
          }
        })
      })
      const tempInfoHash = this.properties[i].infoHash
      const tempSeq = this.properties[i].seq
      if(res){
        if(Buffer.isBuffer(res.getData.v) && typeof(res.getData.seq) === 'number'){

          this.properties[i].infoHash = res.getData.v.toString('hex')
          this.properties[i].seq = res.getData.seq
          this.properties[i].active = true
          this.properties[i].getData = res.getData
          this.properties[i].putData = res.putData
          // if(tempInfoHash !== tis.properties[i].infoHash || tempSeq !== this.properties[i].seq){
          this.emit('update', {address: this.properties[i].address, infoHash: this.properties[i].infoHash, seq: this.properties[i].seq, old: {infoHash: tempInfoHash, seq: tempSeq}, new: this.properties[i], diffInfoHash: tempInfoHash !== this.properties[i].infoHash, diffSeq: tempSeq !== this.properties[i].seq})
          // }
        } else {
          this.emit('inactive', this.properties[i].address + ' is not following the correct structure, going inactive')
          this.properties[i].active = false
        }
      } else if(this.properties[i].active){
        let shareCopy = await new Promise((resolve, reject) => {
          this.dht.put(this.properties[i].getData, (error, hash, number) => {
            if(error){
              this.emit('error', error)
              reject(null)
            } else {
              resolve({hash: hash.toString('hex'), number})
            }
          })
        })
        if(shareCopy){
          this.properties[i].active = true
          this.properties[i].putData = shareCopy
          this.emit('update', {address: this.properties[i].address, infoHash: this.properties[i].infoHash, seq: this.properties[i].seq, old: {infoHash: tempInfoHash, seq: tempSeq}, new: this.properties[i], diffInfoHash: tempInfoHash !== this.properties[i].infoHash, diffSeq: tempSeq !== this.properties[i].seq})
        } else {
          this.emit('inactive', this.properties[i].address + ' is not following the correct structure, going inactive')
          this.properties[i].active = false
        }
      }
      await new Promise(resolve => setTimeout(resolve, 3000))
    }

    if(this.takeOutInActive){
      let tempProps = this.properties.filter(data => {return !data.active})
      for(let i = 0;i < tempProps.length;i++){
        await new Promise((resolve, reject) => {
          this.database.del(tempProps[i].address, error => {
            if(error){
              this.emit('error', error)
              reject(false)
            } else {
              resolve(true)
            }
          })
        })
        await new Promise((resolve, reject) => {
          fs.rm(this.folder + path.sep + tempProps[i].address, {force: true}, error => {
            if(error){
              this.emit('error', error)
              reject(false)
            } else {
              resolve(true)
            }
          })
        })
        this.emit('dead', tempProps[i])
      }
      this.properties = this.properties.filter(data => {return data.active})
      tempProps = null
    }

    // if(this.checks.length){
    //   this.properties = this.properties.filter(data => {return !this.checks.includes(data.address)})
    //   this.checks = []
    // }

    this.emit('check', true)
    this.readyAndNotBusy = true
    setTimeout(() => {if(this.readyAndNotBusy){this.keepItUpdated().catch(error => {this.emit('error', error)})}}, 3600000)
  }

  getAll(which, kind){
    if(!which){
      return this.properties.map(data => {return {address: data.address, infoHash: data.infoHash, seq: data.seq, active: data.active, own: data.own, magnet: data.magnet}})
    } else {
      if(Array.isArray(which) || typeof(which) !== 'object'){
        return null
      } else {
        if(kind){
          return this.properties.filter(main => {return main[which.info] === which.data})
        } else {
          return this.properties.filter(main => {return main[which.info] !== which.data})
        }
      }
    }
  }

  getAddress(){
    return this.properties.map(data => {return data.address})
  }

  getSpecific(which, kind){
    if((!which) || (!which.info || !which.data)){
      return null
    } else {
      let iter = null
      for(let i = 0;i < this.properties.length;i++){
        if(this.properties[i][which.info] === which.data){
          iter = kind ? this.properties[i] : i
          break
        }
      }
      return iter
    }
  }

  // garbage(address){
  //   if(typeof(address) !== 'string' || this.checks.includes(address)){
  //     return false
  //   } else {
  //     this.checks.push(address)
  //     return true
  //   }
  // }

  shred(address, callback){
    if(!callback){
      callback = function(){}
    }
    let found = false
    let iter = null
    let prop = null
    for(let i = 0;i < this.properties.length;i++){
      if(this.properties[i].address === address){
        found = true
        iter = i
        prop = this.properties[i]
        break
      }
    }
    if(found){
      this.database.del(address, error => {
        if(error){
          return callback(error)
        } else {
          this.properties.splice(iter, 1)
          return callback(null, prop)
        }
      })
    } else {
      return callback(new Error('can not find property'))
    }
  }

  grab(address){
    let iter = null
    for(let i = 0;i < this.properties.length;i++){
      if(this.properties[i].address === address){
        iter = this.properties[i]
        break
      }
    }
    return iter
  }

  search(address){
    let iter = null
    for(let i = 0;i < this.properties.length;i++){
      if(this.properties[i].address === address){
        iter = {data: this.properties[i], index: i}
        break
      }
    }
    return iter
  }

  resolve (address, callback) {
    if(!callback){
      callback = () => noop
    }

    // address = this.addressFromLink(address)
    if(!address){
      return callback(new Error('address can not be parsed'))
    }
    const addressKey = Buffer.from(address, 'hex')

    let propertyData = this.grab(address)
    // if(propertyData){
    //   propertyData = propertyData.data
    // }

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
            const own = false
            const active = true
            const magnet = `magnet:?xs=${BTPK_PREFIX}${address}`
            this.database.put(address, JSON.stringify({address, infoHash, seq, own, magnet, active}), error => {
              if(error){
                return callback(error)
              } else {
                if(propertyData){
                  propertyData.infoHash = infoHash
                  propertyData.seq = seq
                  propertyData.own = own
                  propertyData.active = active
                  propertyData.magnet = magnet
                } else {
                  this.properties.push({ address, infoHash, seq, own, magnet, active, getData: res })
                }
                return callback(null, { address, infoHash, seq, own, magnet, active })
              }
            })
          }

        } else if(!res){
          if(propertyData){
            return callback(null, propertyData)
          } else {
            return callback(new Error('Could not resolve address'))
          }
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
    let propertyData = this.search(keypair.address)
    if(propertyData){
      propertyData = propertyData.data
    }
    if(propertyData){
      seq = propertyData.seq + 1
      if(propertyData.infoHash === infoHash){
        return callback(new Error('address key is already attached to this infoHash'))
      }
    }

    const buffAddKey = Buffer.from(keypair.address, 'hex')
    const buffSecKey = Buffer.from(keypair.secret, 'hex')
    const getData = {k: buffAddKey, v: Buffer.from(infoHash, 'hex'), seq, sign: (buf) => {return sign(buf, buffAddKey, buffSecKey)}}
    const own = true
    const active = true
    const magnet = `magnet:?xs=${BTPK_PREFIX}${keypair.address}`

    this.dht.put(getData, (putErr, hash, number) => {
      if(putErr){
        return callback(putErr)
      } else {
        this.database.put(keypair.address, JSON.stringify({address: keypair.address, infoHash, seq, own, active, magnet}), error => {
          if(error){
            return callback(error)
          } else {
            if(propertyData){
              propertyData.infoHash = infoHash
              propertyData.seq = seq
              propertyData.own = own
              propertyData.active = active
              propertyData.magnet = magnet
            } else {
              this.properties.push({address: keypair.address, infoHash, seq, own, active, magnet, putData: {hash, number}, getData})
            }
            return callback(null, {magnet, infoHash, seq, address: keypair.address, magnet, secret: keypair.secret, own, hash: hash.toString('hex'), number})
          }
        })
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
          return callback(new Error('could not find property'))
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
