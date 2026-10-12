// Only encrypted backup material is uploaded to Actions artifacts, including on public repositories.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const source=path.join(process.env.RUNNER_TEMP,'innercircle-signing');
const destination=path.join(process.env.RUNNER_TEMP,'innercircle-encrypted-signing');
const payload=Buffer.from(JSON.stringify({keystore:fs.readFileSync(path.join(source,'release.jks')).toString('base64'),password:process.env.INNERCIRCLE_KEY_PASSWORD}));
const key=crypto.randomBytes(32),iv=crypto.randomBytes(12);
const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
const ciphertext=Buffer.concat([cipher.update(payload),cipher.final()]);
const wrapped=crypto.publicEncrypt({key:fs.readFileSync(path.join(__dirname,'signing-bootstrap-public.pem')),oaepHash:'sha256',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},key);
fs.mkdirSync(destination,{recursive:true});
fs.writeFileSync(path.join(destination,'signing-backup.encrypted.json'),JSON.stringify({key:wrapped.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:ciphertext.toString('base64')}));
