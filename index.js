const DHT = require('bittorrent-dht')
const sodium = require('sodium-universal')
const sha1 = require('simple-sha1')
const fs = require('fs')

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

class WebProperty {
  constructor (opt) {
    if(opt && opt.dht){
        this.dht = opt.dht
      } else {
        this.dht = new DHT()
      }
    if(opt && opt.takeOutInActive){
      this.doNotKeepInActive = opt.takeOutInActive
    } else {
      this.doNotKeepInActive = false
    }
    this.properties = []

    if(fs.existsSync('./data')){
      this.properties = JSON.parse(fs.readFileSync('./data'))
    }
    this.keepItUpdated()
  }

  /*
  when keepItUpdated() runs, it can save only the address, infoHash, and seq and save to file without getData and putData using array.map(),
  then use startUp() to get back the getData and putData from the dht because saving all that data will make the package a lot bigger
  */
  // async startUp(){
  //   if(fs.existsSync('./data')){
  //     this.properties = JSON.parse(fs.readFileSync('./data'))
  //   }
  //   for(let i = 0;i < this.properties.length;i++){
  //     let res = await new Promise((resolve, reject) => {
  //       this.current(this.properties[i].address, (error, data) => {
  //         if(error){
  //           reject(null)
  //         } else {
  //           resolve(data)
  //         }
  //       })
  //     })
  //     if(res){
  //       this.properties[i].infoHash = res.getData.v.ih ? res.v.ih : this.properties[i].infoHash
  //       this.properties[i].seq = res.getData.seq ? res.seq : this.properties[i].seq
  //       this.properties[i].getData = res.getData
  //       this.properties[i].putData = res.putData
  //     }
  //   }
  // }

  /*
  when keepItUpdated() runs, it can save only the address, infoHash, and seq and save to file without getData and putData using array.map(),
  then use startUp() to get back the getData and putData from the dht because saving all that data will make the package a lot bigger
  */

  async keepItUpdated(){
    for(let i = 0;i < this.properties.length;i++){
      let res = await new Promise((resolve, reject) => {
        this.current(this.properties[i].address, (error, data) => {
          if(error){
            reject(null)
          } else {
            resolve(data)
          }
        })
      })
      if(res){
        if(Buffer.isBuffer(res.getData.v)){
          this.properties[i].infoHash = res.getData.v.toString('hex')
        }
        if(typeof(res.getData.seq) === 'number'){
          this.properties[i].seq = res.getData.seq
        }
        this.properties[i].getData = res.getData
        this.properties[i].putData = res.putData
      } else if(this.properties[i].isActive){
        let shareCopy = await new Promise((resolve, reject) => {
          this.dht.put(this.properties[i].getData, (error, hash, number) => {
            if(error){
              reject(null)
            } else {
              resolve({hash: hash.toString('hex'), number})
            }
          })
        })
        if(shareCopy){
          this.properties[i].putData = shareCopy
        } else {
          this.properties[i].isActive = false
        }
      }
      await new Promise(resolve => setTimeout(resolve, 3000))
    }
    if(this.doNotKeepInActive){
      this.properties = this.properties.map(data => {return data.isActive === true})
    }
    fs.writeFileSync('./data', JSON.stringify(this.properties.map(main => {return {address: main.address, infoHash: main.infoHash, seq: main.seq, isActive: main.isActive, own: main.own}})))
    setTimeout(() => {this.keepItUpdated()}, 3600000)
  }

  // might need it later, if we have a 100 torrents, then it would mean 100 lookups one after another, would be good to delay it for a few seconds
  // ddelayNow(milliSec){
  //   return new Promise(resolve => setTimeout(resolve, milliSec))
  // }

  getAll(which, kind){
    try {
      if(!which){
        return this.properties.map(data => {return {address: data.address, infoHash: data.infoHash, seq: data.seq, isActive: data.isActive, own: data.own}})
      } else {
        if(kind){
          return this.properties.map(main => {return main[which.info] === which.data})
        } else {
          return this.properties.map(main => {return main[which.info] !== which.data})
        }
      }
    } catch (error) {
      return error
    }
  }

  getSpecific(which, kind){
    try {
      let iter = null
      for(let i = 0;i < this.properties.length;i++){
        if(this.properties[i][which.info] === which.data){
          iter = kind ? this.properties[i] : i
          break
          // return this.properties[i]
        }
      }
      return iter
    } catch (error) {
      return error
    }
  }

  removeProperty(address){

    let lookAtProperty = this.getProperty(address, false)

    if(lookAtProperty !== null){
      this.properties = this.properties.filter(data => {return data.address !== address})
      // this.properties.splice(lookAtProperty, 1)
      return 'address has been removed'
    } else {
      return 'address is not managed'
    }

  }

  getProperty(address, data){
    let iter = null
    for(let i = 0;i < this.properties.length;i++){
      if(this.properties[i].address === address){
        iter = data ? this.properties[i] : i
        break
        // return this.properties[i]
      }
    }
    return iter
  }

  // updateProperty(address, callback){
  //   if(!callback){
  //     callback = noop
  //   }

  //   let lookAtProperty = this.getProperty(address, true)

  //   if(lookAtProperty){
  //     this.resolve(address, false, (error, data) => {
  //       if(error){
  //         return callback(error)
  //       } else {
  //         lookAtProperty.infoHash = data.infoHash
  //         lookAtProperty.seq = data.seq
  //         return callback(null, lookAtProperty)
  //       }
  //     })
  //   } else {
  //     return callback(new Error('address key is not managed'))
  //   }

  // }

  resolve (address, manage, callback) {
    if(!callback){
      callback = () => noop
    }

    address = this.addressFromLink(address)
    if(!address){
      return callback(new Error('address can not be parsed'))
    }
    const addressKey = Buffer.from(address, 'hex')

    let propertyData = null
    if(manage){
      propertyData = this.getProperty(address, true)
      // if(propertyData){
      //   return callback(new Error('address key is already managed'))
      // }
    }

    sha1(addressKey, (targetID) => {
      this.dht.get(targetID, (err, res) => {
        if(err){
          return callback(err)
        } else if(res){

          if(!Buffer.isBuffer(res.v) || typeof(res.seq) !== 'number'){
            return callback(new Error('data has invalid values'))
          }
          
          const infoHash = res.v.toString('hex')
          const seq = res.seq

          if(manage){
            if(propertyData){
              propertyData.infoHash = infoHash
              propertyData.seq = seq
            } else {
              this.properties.push({ address, infoHash, seq, own: false, isActive: true, getData: res })
            }
          }
          
          return callback(null, { address, infoHash, seq, own: false })
        } else if(!res){
          if(manage && propertyData){
            return callback(null, propertyData)
          } else {
            return callback(new Error('Could not resolve address'))
          }
        }
      })
    })
  }

  publish (keypair, infoHash, seq, manage, callback) {

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
    let propertyData = null
    if(manage){
      propertyData = this.getProperty(keypair.address, true)
      if(propertyData){
        seq = propertyData.seq + 1
        if(propertyData.infoHash === infoHash){
          return callback(new Error('address key is already attached to this infoHash'))
        }
      }
    }

    const buffAddKey = Buffer.from(keypair.address, 'hex')
    const buffSecKey = Buffer.from(keypair.secret, 'hex')
    const getData = {k: buffAddKey, v: Buffer.from(infoHash, 'hex'), seq, sign: (buf) => {return sign(buf, buffAddKey, buffSecKey)}}

    this.dht.put(getData, (putErr, hash, number) => {
      if(putErr){
        return callback(putErr)
      }

      const magnetURI = `magnet:?xs=${BTPK_PREFIX}${keypair.address}`

      if(manage){
        if(propertyData){
          propertyData.infoHash = infoHash
          propertyData.seq = seq
        } else {
          this.properties.push({address: keypair.address, infoHash, seq, own: true, isActive: true, putData: {hash, number}, getData})
        }
      }

      callback(null, {magnetURI, infoHash, seq, address: keypair.address, secret: keypair.secret, own: true, hash: hash.toString('hex')})
    })
  }

  current(address, callback){
    if (!callback) {
      callback = () => noop
    }

    const buffAddKey = Buffer.from(address, 'hex')

    sha1(buffAddKey, (targetID) => {
      const dht = this.dht

      dht.get(targetID, (getErr, getData) => {
        if (getErr) {
          return callback(getErr)
        }

        dht.put(getData, (putErr, hash, number) => {
          if(putErr){
            return callback(putErr)
          } else {
            return callback(null, {getData, putData: {hash: hash.toString('hex'), number}})
          }
        })
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

module.exports = WebProperty

function noop () {}
