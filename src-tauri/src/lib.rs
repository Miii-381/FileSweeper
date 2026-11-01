//! Platform entry points share a crate while keeping desktop Shell code off Android.
#[cfg(not(target_os = "android"))]
mod desktop;
#[cfg(target_os = "android")]
mod mobile;

#[cfg(not(target_os = "android"))]
pub use desktop::run;
#[cfg(target_os = "android")]
pub use mobile::run;
