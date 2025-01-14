use crate::error::identity::IdentityError;
use std::string::FromUtf8Error;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ExportIdentityError {
    #[error("Failed to get identity config: {0}")]
    GetIdentityConfigFailed(IdentityError),

    #[error("The specified identity does not exist: {0}")]
    IdentityDoesNotExist(IdentityError),

    #[error("Failed to load pem file: {0}")]
    LoadPemFailed(IdentityError),

    #[error("Could not translate pem file to text: {0}")]
    TranslatePemContentToTextFailed(FromUtf8Error),

    #[error("Failed to validate pem file: {0}")]
    ValidatePemFileFailed(IdentityError),
}
