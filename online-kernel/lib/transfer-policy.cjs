'use strict';
const MAX_BYTES=1024*1048576,MAX_AUTHORIZATION_MS=15*60000;
function validGrantExpiry(expires,now=Date.now()){
 return Number.isSafeInteger(expires)&&Number.isSafeInteger(now)&&expires>now&&expires-now<=MAX_AUTHORIZATION_MS;
}
module.exports={MAX_BYTES,MAX_AUTHORIZATION_MS,validGrantExpiry};
