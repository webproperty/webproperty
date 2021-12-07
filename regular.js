const DHT = require('bittorrent-dht')
const ed = require('ed25519-supercop')
const sha1 = require('simple-sha1')
const fs = require('fs')
const path = require('path')
const level = require('level')
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

async function startUp(self){
  let contents = self.properties.map(data => {return data.address})
  for await (const [key, value] of database.iterator()){
    let property = JSON.parse(value)
    if(!contents.includes(property.address)){
      self.properties.push(property)
    }
  }
  contents = null
  // await keepSigned(self)
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
    self.emit('dead', tempProps[i])
  }
  self.properties = self.properties.filter(data => {return data.active})
  tempProps = null
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
      dht.put(tempProps[i].getData, (error, hash, number) => {
        if(error){
          reject(null)
        } else {
          resolve({hash: hash.toString('hex'), number})
        }
      })
    })
    if(tempData){
      tempProps[i].putData = tempData
    }
  }
  setTimeout(() => {if(readyAndNotBusy){keepSigned(self).catch(error => {self.emit('error', error)})}}, 1800000)
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
  // setTimeout(() => {if(self.readyAndNotBusy){self.keepItSaved().catch(error => {self.emit('error', error)})}}, 1800000)
}

async function keepItUpdated(self){
  readyAndNotBusy = false
  self.emit('check', false)
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
          if(!Buffer.isBuffer(res.get.v) || !checkHash.test(res.get.v.toString('hex')) || typeof(res.get.seq) !== 'number'){
            self.properties[i].active = false
            // self.emit('deactivate', self.properties[i])
          } else {
            if(!self.properties[i].signed){
              self.properties[i].address = res.get.k.toString('hex')
              self.properties[i].infoHash = res.get.v.toString('hex')
              self.properties[i].sequence = res.get.seq
              self.properties[i].sig = res.get.sig.toString('hex')
            }
            if(!res.put){
              self.emit('error', new Error('could not put ' + self.properties[i].address + ' back into the network, still active though since it is being shared by other users'))
            }
          }
        }
      } else {
        let putRes = await new Promise((resolve, reject) => {
          dht.put({k: Buffer.from(self.properties[i].address, 'hex'), v: self.properties[i].infoHash, seq: self.properties[i].sequence, sig: Buffer.from(self.properties[i].sig, 'hex')}, (error, hash, number) => {
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
        if(!Buffer.from(getRes.v) || !checkHash.test(getRes.v.toString('hex')) || typeof(getRes.seq) !== 'number'){
          self.properties[i].active = false
        } else {
          if(!self.properties[i].active){
            self.properties[i].address = getRes.k.toString('hex')
            self.properties[i].infoHash = getRes.v.toString('hex')
            self.properties[i].sequence = getRes.seq
            self.properties[i].sig = getRes.sig.toString('hex')
          }
          self.properties[i].active = true
        }
      } else {
        let putRes = await new Promise((resolve, reject) => {
          dht.put({k: Buffer.from(self.properties[i].address, 'hex'), v: self.properties[i].infoHash, seq: self.properties[i].sequence, sig: Buffer.from(self.properties[i].sig, 'hex')}, (error, hash, number) => {
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

let dht = null
let database = null
let folder = null
let takeOutInActive = null
let readyAndNotBusy = null
let check = null

class WebProperty extends EventEmitter {
  constructor (opt) {
    super()
    if(!opt){
      opt = {}
      opt.dht = new DHT({verify: ed.verify})
      opt.takeOutInActive = false
      opt.check = false
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
    }
    this.properties = []
    dht = opt.dht
    database = level('database')
    folder = path.resolve('./magnet')
    takeOutInActive = opt.takeOutInActive
    readyAndNotBusy = true
    check = opt.check
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

  resolve (address, manage, callback) {
    if(!callback){
      callback = () => noop
    }

    // address = this.addressFromLink(address)
    if(!address){
      return callback(new Error('address can not be parsed'))
    }
    const addressKey = Buffer.from(address, 'hex')

    let propertyData = manage ? this.grab(address) : null
    // if(manage){
    //   propertyData = this.grab(address)
    // }

    sha1(addressKey, (targetID) => {
      dht.get(targetID, (err, res) => {
        if(err){
          return callback(err)
        } else if(res){

          if(!Buffer.isBuffer(res.v) || !checkHash.test(res.v.toString('hex')) || typeof(res.seq) !== 'number'){
            return callback(new Error('data has invalid values'))
          } else {
            let main = {magnet: `magnet:?xs=${BTPK_PREFIX}${address}`, address, infoHash: res.v.toString('hex'), sequence: res.seq, active: true, signed: false, sig: res.sig.toString('hex')}
            if(manage){
              database.put(main.address, JSON.stringify(main), error => {
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
                  return callback(null, {...main, id: res.id.toString('hex')})
                }
              })
            } else {
              return callback(null, {...main, id: res.id.toString('hex')})
            }

          }

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

  publish (keypair, infoHash, sequence, manage, callback) {

    if (!callback) {
      callback = () => noop
    }
    if(!infoHash || typeof(infoHash) !== 'string' || !checkHash.test(infoHash)){
      return callback(new Error('must have infoHash'))
    }
    if(!sequence || typeof(sequence) !== 'number'){
      sequence = 0
    }
    if((!keypair) || (!keypair.address || !keypair.secret)){
      keypair = this.createKeypair(false)
    }
    let propertyData = null
    if(manage){
      propertyData = this.grab(keypair.address)
      if(propertyData){
        sequence = propertyData.sequence + 1
        if(propertyData.infoHash === infoHash){
          return callback(new Error('address key is already attached to this infoHash'))
        }
      }
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
        let main = {magnet: `magnet:?xs=${BTPK_PREFIX}${keypair.address}`, address: keypair.address, infoHash, sequence, active: true, signed: true, sig: sig.toString('hex')}
        if(manage){
          database.put(main.address, JSON.stringify(main), error => {
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
              return callback(null, {...main, hash, number})
            }
          })
        } else {
          return callback(null, {...main, hash, number})
        }
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
              return callback(null, getData, {hash: hash, number})
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
              return callback(null, getData, {hash: hash, number})
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

module.exports = {WebProperty, verify: ed.verify}

function noop () {}
