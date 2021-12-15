# WebProperty

WebProperty is a BEP 46 package
https://www.bittorrent.org/beps/bep_0046.html

Using this package you can update your torrents by using a public key

There are 3 modules in this package, they are the following: lookup, managed, and regular


## lookup
`const {WebProperty, verify} = require('webproperty/lookup.js')`
lookup is used for the bare minimum, you can publish an infohash under a public key and you can resolve a public key to a infohash


### publish
#### take an infohash and publish it in the network with a public key


`webproperty.publish(keypairObject, infoHashString, sequenceNumber, metaObject, (errorCallback, responseCallback))`


`keypair`


is optional, can either be an object with the address(public key) and secret(private key) `{address: publickey, secret: privatekey}`, or it can be a falsy value like `null` and it will create a keypair for you


`infoHashString`


is required, it needs to be a 40 character infohash `string` of a torrent


`sequenceNumber`


is optional, it can either be the sequence `number` you want to publish the data at, or it can be `null` and the package will take care of the sequence for you


`metaObject`


is optional, it is an `object` that holds strings of extra details that you might want to add for the torrent, or leave it `null`, remember to be careful here because there is a size limit when it comes to saving data in the network


`(errorCallback, responseCallback)`


is required, errorCallback is returned if it would not publish the data for some reason, responseCallback is returned the data was successfully published


--------------------------

### resolve
#### take a public key and get all of the associated data for it including the infohash tied to it


`webproperty.resolve(publicKeyAddressString, (errorCallback, responseCallback))`


`publicKeyAddressString`


is required, it needs to be a 64 character public key `string`


`(errorCallback, responseCallback)`


is required, errorCallback is returned if it could not resolve the address to an infohash for some reason, responseCallback is returned if the address was successfully resolved to a infohash


--------------------------------

### shred
#### remove an address, if you are helping putting the data back into the network


`webproperty.shred(publicKeyAddressString, (errorCallback, responseCallback))`


`publicKeyAddressString`


is required, it needs to be a 64 character public key `string`


`(errorCallback, responseCallback)`


is required, errorCallback is returned if it could not remove the data for some reason, responseCallback is returned the data was successfully removed


------------------------------------

### current
#### takes an address and gets the data from the network and then puts that data back into the network to keep it active


`webproperty.current(publicKeyAddressString, (errorCallback, responseCallback))`


`publicKeyAddressStrinng`


is required, must be a 64 character public key


`(errorCallback, responseCallback)`


is required, errorCallback is returned if it could not both get the data and put the data back, responseCallback is returned if it both got the data and put it back into the network


-------------------------------------------

### createKeypair
#### creates a keypair for you


`webproperty.createKeypair()`


return a `{address: publicKeyString, secret: privateKeyString}` object, both address and secret in the object will be a string


----------------------------------------------

### addressFromLink
#### takes a magnet link or a uri like bt:// or bittorrent:// or just the address by itself


`webproperty.addressFromLink(linkString)`


returns the public key address after parsing the string


-------------------------------------------------

## managed - docs coming soon

## regular - docs coming soon