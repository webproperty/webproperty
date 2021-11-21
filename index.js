const Regular = require('./regular.js')
const Managed = require('./managed.js')
const LookUp = require('./lookup.js')

module.exports = (data) => {
    if(typeof(data) !== 'string'){
        return null
    }
    if(data === 'regular'){
        return Regular
    } else if(data === 'managed'){
        return Managed
    } else if(data === 'lookup'){
        return LookUp
    }
}