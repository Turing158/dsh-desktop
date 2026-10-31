//! Optional, per-user authenticated verification receipts. Losing or corrupting
//! a receipt only causes full verification; it never changes runtime selection.
use std::{fs, io::{self, Read, Write}, path::Path};
use serde::{de::DeserializeOwned, Serialize};
const MAX_RECEIPT:u64=128*1024*1024;
const ENTROPY:&[u8]=b"dsh-desktop-runtime-verification-v1";

#[cfg(windows)]
fn protect(bytes:&[u8],decrypt:bool)->io::Result<Vec<u8>> {
    use windows::{core::PCWSTR, Win32::{Foundation::{HLOCAL,LocalFree}, Security::Cryptography::{
        CryptProtectData,CryptUnprotectData,CRYPT_INTEGER_BLOB,CRYPTPROTECT_UI_FORBIDDEN,
    }}};
    let input=CRYPT_INTEGER_BLOB {cbData:bytes.len().try_into().map_err(|_|io::Error::other("startup-cache-size"))?,pbData:bytes.as_ptr().cast_mut()};
    let entropy=CRYPT_INTEGER_BLOB {cbData:ENTROPY.len() as u32,pbData:ENTROPY.as_ptr().cast_mut()};
    let mut output=CRYPT_INTEGER_BLOB::default();
    unsafe {
        if decrypt {
            CryptUnprotectData(&input,None,Some(&entropy),None,None,CRYPTPROTECT_UI_FORBIDDEN,&mut output)
        } else {
            CryptProtectData(&input,PCWSTR::null(),Some(&entropy),None,None,CRYPTPROTECT_UI_FORBIDDEN,&mut output)
        }.map_err(io::Error::other)?;
        // DPAPI's returned buffer has LocalAlloc ownership on both paths.
        let result=if output.cbData as u64>MAX_RECEIPT || output.pbData.is_null() {
            Err(io::Error::other("startup-cache-size"))
        } else {Ok(std::slice::from_raw_parts(output.pbData,output.cbData as usize).to_vec())};
        let _=LocalFree(Some(HLOCAL(output.pbData.cast())));
        result
    }
}
pub fn load<T:DeserializeOwned>(path:&Path)->io::Result<T> {
    #[cfg(windows)] {
        let (mut file,_)=crate::update_io::Stamp::inspect(path,false)?;
        if file.metadata()?.len()>MAX_RECEIPT {return Err(io::Error::other("startup-cache-size"));}
        let mut bytes=Vec::new();Read::by_ref(&mut file).take(MAX_RECEIPT+1).read_to_end(&mut bytes)?;
        if bytes.len() as u64>MAX_RECEIPT {return Err(io::Error::other("startup-cache-size"));}
        let plain=protect(&bytes,true)?;
        serde_json::from_slice(&plain).map_err(io::Error::other)
    }
    #[cfg(not(windows))] {let _=path;Err(io::Error::other("startup-cache-unavailable"))}
}
pub fn save(path:&Path,value:&impl Serialize)->io::Result<()> {
    #[cfg(windows)] {
        let plain=serde_json::to_vec(value).map_err(io::Error::other)?;
        if plain.len() as u64>MAX_RECEIPT {return Err(io::Error::other("startup-cache-size"));}
        let bytes=protect(&plain,false)?;
        let directory=path.parent().ok_or_else(||io::Error::other("startup-cache-parent"))?;
        // Validate existing ancestors before creating the cache directory.
        for parent in directory.ancestors().filter(|parent|parent.is_absolute()) {
            if parent.try_exists()? {crate::update_io::Stamp::inspect(parent,true)?;}
        }
        fs::create_dir_all(directory)?;
        crate::update_io::Stamp::inspect(directory,true)?;
        let mut temporary=tempfile::NamedTempFile::new_in(directory)?;
        temporary.write_all(&bytes)?;temporary.as_file().sync_all()?;
        temporary.persist(path).map_err(|error|error.error)?;
        Ok(())
    }
    #[cfg(not(windows))] {let _=(path,value);Err(io::Error::other("startup-cache-unavailable"))}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(windows)]
    fn changed_or_plaintext_receipts_cannot_supply_verification_results() {
        let root=tempfile::tempdir().unwrap();let path=root.path().join("verified/cache.bin");
        let value=vec!["verified runtime","fingerprint"];
        save(&path,&value).unwrap();assert_eq!(load::<Vec<String>>(&path).unwrap(),value);
        let mut bytes=fs::read(&path).unwrap();let index=bytes.len()/2;bytes[index]^=1;fs::write(&path,bytes).unwrap();
        assert!(load::<Vec<String>>(&path).is_err());
        fs::write(&path,serde_json::to_vec(&value).unwrap()).unwrap();assert!(load::<Vec<String>>(&path).is_err());
    }
}
