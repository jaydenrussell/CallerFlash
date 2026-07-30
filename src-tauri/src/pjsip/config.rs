use serde::{Deserialize, Deserializer, Serialize, Serializer};
use secrecy::{ExposeSecret, SecretString};

#[derive(Debug, Clone)]
pub struct PjsipSipConfig {
    pub username: String,
    pub password: SecretString,
    pub server: String,
    pub port: Option<u16>,
    pub protocol: Option<String>,
    pub auth_username: Option<String>,
    pub register_expiry: Option<u32>,
}

impl Serialize for PjsipSipConfig {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("PjsipSipConfig", 7)?;
        st.serialize_field("username", &self.username)?;
        st.serialize_field("password", self.password.expose_secret())?;
        st.serialize_field("server", &self.server)?;
        st.serialize_field("port", &self.port)?;
        st.serialize_field("protocol", &self.protocol)?;
        st.serialize_field("authUsername", &self.auth_username)?;
        st.serialize_field("registerExpiry", &self.register_expiry)?;
        st.end()
    }
}

impl<'de> Deserialize<'de> for PjsipSipConfig {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Raw {
            username: String,
            password: String,
            server: String,
            port: Option<u16>,
            protocol: Option<String>,
            auth_username: Option<String>,
            register_expiry: Option<u32>,
        }
        let raw = Raw::deserialize(d)?;
        Ok(Self {
            username: raw.username,
            password: SecretString::from(raw.password),
            server: raw.server,
            port: raw.port,
            protocol: raw.protocol,
            auth_username: raw.auth_username,
            register_expiry: raw.register_expiry,
        })
    }
}

impl PjsipSipConfig {
    pub fn validate(&self) -> Result<(), String> {
        crate::pjsip::transport::validate_config(self)
    }
}

#[derive(Debug, Clone)]
pub struct RegistrationConfig {
    pub expires: u32,
    pub retry_interval: u32,
    pub max_retries: u32,
    pub keepalive_interval: u32,
}

impl Default for RegistrationConfig {
    fn default() -> Self {
        Self {
            expires: 300,
            retry_interval: 60,
            max_retries: 5,
            keepalive_interval: 60,
        }
    }
}