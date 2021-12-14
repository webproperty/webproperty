const DHT = require('bittorrent-dht')
const sha1 = require('simple-sha1')
const fs = require('fs')
const path = require('path')
const level = require('level')
const ed = require('ed25519-supercop')
const bencode = require('bencode')
const EventEmitter = require('events').EventEmitter

const BTPK_PREFIX = 'urn:btpk:'
const BITH_PREFIX = 'urn:btih:'
const checkHash = new RegExp('^[a-fA-F0-9]{40}$')
function encodeSigData (msg) {
  const ref = { seq: msg.seq, v: msg.v }
  if (msg.salt) ref.salt = msg.salt
  return bencode.encode(ref).slice(1, -1)
}

let dht = null
let check = null
let database = null
let folder = null
let takeOutInActive = null
let readyAndNotBusy = null

async function startUp(self){
  let contents = self.properties.map(data => {return data.address})
  for await (const [key, value] of database.iterator()){
    let property = JSON.parse(value)
    if(!contents.includes(property.address)){
      self.properties.push(property)
    }
  }
  contents = null
  // await keepSigned()
  await keepItUpdated(self)
}

async function purgeInActive(self){
  let tempProps = self.properties.filter(data => {return !data.active})
  for(let i = 0;i < tempProps.length;i++){
    await new Promise((resolve, reject) => {
      database.del(tempProps[i].address, error => {
        if(error){
          self.emit('error', error)
          reject(false)
        } else {
          resolve(true)
        }
      })
    })
    await new Promise((resolve, reject) => {
      fs.rm(folder + path.sep + tempProps[i].address, {force: true}, error => {
        if(error){
          self.emit('error', error)
          reject(false)
        } else {
          resolve(true)
        }
      })
    })
    self.emit('remove', tempProps[i])
  }
  self.properties = self.properties.filter(data => {return data.active})
  tempProps = null
}

async function keepItSaved(self){
  let contents = await new Promise((resolve, reject) => {
    fs.readdir(folder, {withFileTypes: true}, (error, data) => {
      if(error){
        self.emit('error', error)
        reject(null)
      } else if(!data){
        self.emit('error', new Error('can not find the directory of the properties'))
        reject(null)
      } else if(data){
        resolve(data)
      }
    })
  })
  let tempContents = self.properties.map(data => {return data.address})
  contents = contents.filter(data => {return !tempContents.includes(data)})
  for(let i = 0;i < contents.length;i++){
    await new Promise((resolve, reject) => {
      fs.rm(folder + path.sep + contents[i], {force: true}, error => {
        if(error){
          self.emit('error', error)
          reject(false)
        } else {
          resolve(true)
        }
      })
    })
  }
  contents = null
  tempContents = null
  for(let i = 0;i < self.properties.length;i++){
    await new Promise((resolve, reject) => {
      fs.writeFile(folder + path.sep + self.properties[i].address, JSON.stringify(self.properties[i]), error => {
        if(error){
          self.emit('error', error)
          reject(false)
        } else {
          resolve(true)
        }
      })
    })
    await new Promise((resolve, reject) => {
      database.put(self.properties[i].address, JSON.stringify(self.properties[i]), error => {
        if(error){
          self.emit('error', error)
          reject(false)
        } else {
          resolve(true)
        }
      })
    })
  }
  // setTimeout(() => {if(readyAndNotBusy){keepItSaved(self).catch(error => {self.emit('error', error)})}}, 1800000)
}

async function keepSigned(self){
  let tempProps = self.properties.filter(data => {return data.signed})
  for(let i = 0;i < tempProps.length;i++){
      let tempData = await new Promise((resolve, reject) => {
      // self.current(tempProps[i].address, (error, data => {
      //   if(error){
      //     reject(error)
      //   } else {
      //     resolve(data)
      //   }
      // }))
      dht.put({k: Buffer.from(tempProps[i].address, 'hex'), v: {ih: tempProps[i].infoHash, ...tempProps[i].stuff}, seq: tempProps[i].sequence, sig: Buffer.from(tempProps[i].sig, 'hex')}, (error, hash, number) => {
          if(error){
          reject(null)
          } else {
          resolve({hash: hash.toString('hex'), number})
          }
      })
    })
      if(tempData){
        console.log('put ' + tempProps[i].address + ' back')
      } else {
        console.log('could not put ' + tempProps[i].address + ' back')
      }
  }
  setTimeout(() => {if(readyAndNotBusy){keepSigned(self).catch(error => {self.emit('error', error)})}}, 1800000)
}

function deDupe(self){
  let test = []
  let mainData = []
  for(let i = 0;i < self.properties.length;i++){
    if(!test.includes(self.properties[i].address)){
      test.push(self.properties[i].address)
      mainData.push(self.properties[i])
    }
  }
  test = null
  return mainData
}

async function keepItUpdated(self){
  readyAndNotBusy = false
  self.emit('check', false)
  self.properties = deDupe(self)
  for(let i = 0;i < self.properties.length;i++){
    const tempInfoHash = self.properties[i].infoHash
    const tempSequence = self.properties[i].sequence
    if(self.properties[i].active){
      let res = await new Promise((resolve, reject) => {
        self.bothGetPut(self.properties[i].address, (error, get, put) => {
          if(error){
            self.emit('error', error)
            reject(null)
          } else {
            resolve({get, put})
          }
        })
      })
      if(res){
        if(res.get){
          try {
            if(!checkHash.test(res.get.v.ih.toString('utf-8')) || !Number.isInteger(res.get.seq)){
              throw new Error('data is invalid')
            }
            for(const prop in res.get.v){
              res.get.v[prop] = res.get.v[prop].toString('utf-8')
            }
            let {ih, ...stuff} = res.get.v
            if(!self.properties[i].signed){
              self.properties[i].address = res.get.k.toString('hex')
              self.properties[i].infoHash = ih
              self.properties[i].sequence = res.get.seq
              self.properties[i].sig = res.get.sig.toString('hex')
              self.properties[i].stuff = stuff
            }
          } catch (error) {
            self.emit('error', error)
            self.properties[i].active = false
          }
        }
        if(res.put){
          self.emit('extra', 'put ' + self.properties[i].address + ' back into the network')
        } else {
          self.emit('extra', 'could not put ' + self.properties[i].address + ' back into the network, still active though since it is being shared by other users')
        }
      } else {
        let putRes = await new Promise((resolve, reject) => {
          dht.put({k: Buffer.from(self.properties[i].address, 'hex'), v: {ih: self.properties[i].infoHash, ...self.properties[i].stuff}, seq: self.properties[i].sequence, sig: Buffer.from(self.properties[i].sig, 'hex')}, (error, hash, number) => {
            if(error){
              self.emit('error', error)
              reject(null)
            } else {
              resolve({hash, number})
            }
          })
        })
        if(!putRes){
          self.properties[i].active = false
        }
      }
      if(self.properties[i].active){
        if(tempInfoHash !== self.properties[i].infoHash || tempSequence !== self.properties[i].sequence){
          self.emit('update', {...self.properties[i], prevInfoHash: tempInfoHash, prevSequence: tempSequence, diffHash: tempInfoHash !== self.properties[i].infoHash, diffSeq: tempSequence !== self.properties[i].sequence})
        } else {
          self.emit('current', {...self.properties[i], prevInfoHash: tempInfoHash, prevSequence: tempSequence, diffHash: tempInfoHash !== self.properties[i].infoHash, diffSeq: tempSequence !== self.properties[i].sequence})
        }
      } else if(!self.properties[i].active){
        self.emit('deactivate', {...self.properties[i], prevInfoHash: tempInfoHash, prevSequence: tempSequence, diffHash: tempInfoHash !== self.properties[i].infoHash, diffSeq: tempSequence !== self.properties[i].sequence})
      }
    } else if(check){
      let getRes = await new Promise((resolve, reject) => {
        dht.get(self.properties[i].address, (error, data) => {
          if(error){
            self.emit('error', error)
            reject(null)
          } else if(data){
            resolve(data)
          } else if(!data){
            self.emit('error', new Error('could not find property'))
            reject(null)
          }
        })
      })
      if(getRes){
        try {
          if(!checkHash.test(getRes.v.ih.toString('utf-8')) || !Number.isInteger(getRes.seq)){
            throw new Error('data is invalid')
          }
          for(const prop in getRes.v){
            getRes.v[prop] = getRes.v[prop].toString('utf-8')
          }
          let {ih, ...stuff} = getRes.v
          if(!self.properties[i].active){
            self.properties[i].address = getRes.k.toString('hex')
            self.properties[i].infoHash = ih
            self.properties[i].sequence = getRes.seq
            self.properties[i].sig = getRes.sig.toString('hex')
            self.properties[i].stuff = stuff
          }
          self.properties[i].active = true
        } catch (error) {
          self.emit('error', error)
          self.properties[i].active = false
        }
      } else {
        let putRes = await new Promise((resolve, reject) => {
          dht.put({k: Buffer.from(self.properties[i].address, 'hex'), v: {ih: self.properties[i].infoHash, ...self.properties[i].stuff}, seq: self.properties[i].sequence, sig: Buffer.from(self.properties[i].sig, 'hex')}, (error, hash, number) => {
            if(error){
              self.emit('error', error)
              reject(null)
            } else {
              resolve({hash, number})
            }
          })
        })
        if(putRes){
          self.properties[i].active = true
        } else {
          self.properties[i].active = false
        }
      }
      if(self.properties[i].active){
        if(tempInfoHash !== self.properties[i].infoHash || tempSequence !== self.properties[i].sequence){
          self.emit('update', {...self.properties[i], prevInfoHash: tempInfoHash, prevSequence: tempSequence, diffHash: tempInfoHash !== self.properties[i].infoHash, diffSeq: tempSequence !== self.properties[i].sequence})
        } else {
          self.emit('current', {...self.properties[i], prevInfoHash: tempInfoHash, prevSequence: tempSequence, diffHash: tempInfoHash !== self.properties[i].infoHash, diffSeq: tempSequence !== self.properties[i].sequence})
        }
      } else if(!self.properties[i].active){
        self.emit('inactive', {...self.properties[i], prevInfoHash: tempInfoHash, prevSequence: tempSequence, diffHash: tempInfoHash !== self.properties[i].infoHash, diffSeq: tempSequence !== self.properties[i].sequence})
      }
    } else if(!self.properties[i].active){
      self.emit('inactive', {...self.properties[i], prevInfoHash: tempInfoHash, prevSequence: tempSequence, diffHash: tempInfoHash !== self.properties[i].infoHash, diffSeq: tempSequence !== self.properties[i].sequence})
    }
    await new Promise(resolve => setTimeout(resolve, 3000))
  }

  if(takeOutInActive){
    await purgeInActive(self)
  }

  await keepItSaved(self)

  // if(self.checks.length){
  //   self.properties = self.properties.filter(data => {return !self.checks.includes(data.address)})
  //   self.checks = []
  // }

  self.emit('check', true)
  readyAndNotBusy = true
  setTimeout(() => {if(readyAndNotBusy){keepItUpdated(self).catch(error => {self.emit('error', error)})}}, 3600000)
}

class WebProperty extends EventEmitter {
  constructor (opt) {
    super()
    if(!opt){
      opt = {}
      opt.dht = new DHT({verify: ed.verify})
      opt.takeOutInActive = false
      opt.check = false
      opt.folder = path.resolve('./magnet')
    } else {
      if(typeof(opt) !== 'object' || Array.isArray(opt)){
        opt = {}
      }
      if(!opt.dht){
        opt.dht = new DHT({verify: ed.verify})
      }
      if(!opt.takeOutInActive){
        opt.takeOutInActive = false
      }
      if(!opt.check){
        opt.check = false
      }
      if(!opt.folder){
        opt.folder = path.resolve('./magnet')
      }
    }
    this.properties = []
    dht = opt.dht
    check = opt.check
    takeOutInActive = opt.takeOutInActive
    readyAndNotBusy = true
    database = level('database')
    folder = path.resolve(opt.folder)
    if(!fs.existsSync('./magnet')){
      fs.mkdirSync('./magnet', {recursive: true})
    }

    startUp(this).catch(error => {
      this.emit('error', error)
    })
  }

  getAll(which, kind){
    if(!which){
      return this.properties.map(data => {return {address: data.address, infoHash: data.infoHash, sequence: data.sequence, active: data.active, magnet: data.magnet}})
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
      database.del(prop.address, error => {
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
    if(!address || typeof(address) !== 'string'){
      return callback(new Error('address can not be parsed'))
    }
    const addressKey = Buffer.from(address, 'hex')

    let propertyData = this.grab(address)
    // if(propertyData){
    //   propertyData = propertyData.data
    // }

    sha1(addressKey, (targetID) => {
      dht.get(targetID, (err, res) => {
        if(err){
          return callback(err)
        } else if(res){

            try {
              if(!checkHash.test(res.v.ih.toString('utf-8')) || !Number.isInteger(res.seq)){
                throw new Error('data is invalid')
              }
              for(const prop in res.v){
                res.v[prop] = res.v[prop].toString('utf-8')
              }
            } catch (error) {
              return callback(error)
            }
            let {ih, ...stuff} = res.v
            let main = {magnet: `magnet:?xs=${BTPK_PREFIX}${address}`, address, infoHash: ih, sequence: res.seq, active: true, signed: false, sig: res.sig.toString('hex'), stuff}
            database.put(address, JSON.stringify(main), error => {
              if(error){
                return callback(error)
              } else {
                if(propertyData){
                  for(let prop in main){
                    propertyData[prop] = main[prop]
                  }
                } else {
                  this.properties.push(main)
                }
                return callback(null, { ...main, netdata: res })
              }
            })

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

  publish (keypair, text, sequence, callback) {

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
    if((!keypair) || (!keypair.address || !keypair.secret)){
      keypair = this.createKeypair()
    }

    let propertyData = this.grab(keypair.address)
    if(propertyData){
      sequence = propertyData.sequence + 1
      // if(propertyData.infoHash === infoHash){
      //   return callback(new Error('address key is already attached to this infoHash'))
      // }
    }

    const buffAddKey = Buffer.from(keypair.address, 'hex')
    const buffSecKey = Buffer.from(keypair.secret, 'hex')
    const v = text
    const seq = sequence
    const buffSig = ed.sign(encodeSigData({seq, v}), buffAddKey, buffSecKey)
    // const mainletagnet, address: keypair.address, infoHash, sequence}
    dht.put({k: buffAddKey, v, seq, sig: buffSig}, (putErr, hash, number) => {
      if(putErr){
        return callback(putErr)
      } else {
        let {ih, ...stuff} = text
        let main = {magnet: `magnet:?xs=${BTPK_PREFIX}${keypair.address}`, address: keypair.address, infoHash: ih, sequence, active: true, signed: true, sig: buffSig.toString('hex'), stuff}
        database.put(keypair.address, JSON.stringify(main), error => {
          if(error){
            return callback(error)
          } else {
            if(propertyData){
              for(let prop in main){
                propertyData[prop] = main[prop]
              }
            } else {
              this.properties.push(main)
            }
            return callback(null, {...main, netdata: {hash, number}})
          }
        })
      }
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
              return callback(null, getData, {hash: hash.toString('hex'), number})
            }
          })
        } else if(!getData){
          return callback(new Error('could not find property'))
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

module.exports = {WebProperty, verify: ed.verify}

function noop () {}
