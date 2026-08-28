use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{ErrorKind, Read, Write},
    net::{Shutdown, SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const SERVICE_TYPE: &str = "_spliceconnect._tcp.local.";
const MAX_CONNECTIONS: usize = 64;
const MAX_PENDING_COMMANDS: usize = 256;
const MAX_HANDOFF_TRACKS: usize = 1_000;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectPlayback {
    pub(crate) track_id: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) artist: Option<String>,
    pub(crate) album: Option<String>,
    pub(crate) cover_art_id: Option<String>,
    pub(crate) is_playing: bool,
    pub(crate) position: f64,
    pub(crate) duration: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectPeer {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) platform: String,
    pub(crate) playback: ConnectPlayback,
    pub(crate) updated_at: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectHandoff {
    pub(crate) track_ids: Vec<String>,
    pub(crate) current_track_id: String,
    pub(crate) position: f64,
    pub(crate) is_playing: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectGroup {
    pub(crate) id: String,
    pub(crate) leader_id: String,
    pub(crate) track_id: String,
    pub(crate) position: f64,
    pub(crate) is_playing: bool,
    pub(crate) sent_at: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectGroupJoin {
    pub(crate) group: ConnectGroup,
    pub(crate) handoff: ConnectHandoff,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectCommand {
    pub(crate) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) handoff: Option<ConnectHandoff>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) group: Option<ConnectGroup>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) group_join: Option<ConnectGroupJoin>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectSnapshot {
    pub(crate) is_available: bool,
    pub(crate) local_device_id: Option<String>,
    pub(crate) peers: Vec<ConnectPeer>,
    pub(crate) commands: Vec<ConnectCommand>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireMessage {
    kind: String,
    authentication: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    peer: Option<ConnectPeer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<ConnectCommand>,
}

struct PeerEntry {
    peer: ConnectPeer,
    received_at: Instant,
}

struct DiscoveredService {
    socket: SocketAddr,
    last_attempt: Instant,
}

struct Runtime {
    alive: AtomicBool,
    authentication: String,
    local_peer: Mutex<ConnectPeer>,
    peers: Mutex<HashMap<String, PeerEntry>>,
    commands: Mutex<Vec<ConnectCommand>>,
    routes: Mutex<HashMap<String, Arc<Mutex<TcpStream>>>>,
    service_routes: Mutex<HashMap<String, String>>,
    discovered: Mutex<HashMap<String, DiscoveredService>>,
    connections: Mutex<Vec<Arc<Mutex<TcpStream>>>>,
    mdns: ServiceDaemon,
}

#[derive(Default)]
pub(crate) struct SpliceConnectState(Mutex<Option<Arc<Runtime>>>);

impl SpliceConnectState {
    pub(crate) fn configure(
        &self,
        server: &str,
        username: &str,
        password: &str,
    ) -> Result<(), String> {
        self.stop();
        let authentication = fingerprint(server, username, password);
        let device_id = persistent_device_id();
        let device_name = hostname::get()
            .ok()
            .and_then(|name| name.into_string().ok())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "Splice Desktop".to_string());
        let platform = if cfg!(target_os = "macos") {
            "macOS"
        } else if cfg!(target_os = "windows") {
            "Windows"
        } else {
            "Linux"
        };
        let listener = TcpListener::bind("0.0.0.0:0")
            .map_err(|error| format!("Splice Connect could not open a local listener: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("Splice Connect could not configure its listener: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("Splice Connect could not read its local port: {error}"))?
            .port();
        let local_ip = local_ip_address::local_ip().map_err(|error| {
            format!("Splice Connect could not find a local network address: {error}")
        })?;
        let mdns = ServiceDaemon::new()
            .map_err(|error| format!("Splice Connect could not start discovery: {error}"))?;
        let _ = mdns.set_service_name_len_max(32);
        let suffix: String = device_id
            .chars()
            .filter(|character| *character != '-')
            .take(8)
            .collect();
        let instance_name = format!("Splice-{suffix}");
        let host_name = format!("splice-{suffix}.local.");
        let service = ServiceInfo::new(
            SERVICE_TYPE,
            &instance_name,
            &host_name,
            local_ip,
            port,
            None::<HashMap<String, String>>,
        )
        .map_err(|error| format!("Splice Connect could not describe this device: {error}"))?;
        mdns.register(service)
            .map_err(|error| format!("Splice Connect could not advertise this device: {error}"))?;

        let runtime = Arc::new(Runtime {
            alive: AtomicBool::new(true),
            authentication,
            local_peer: Mutex::new(ConnectPeer {
                id: device_id,
                name: device_name,
                platform: platform.to_string(),
                playback: ConnectPlayback::default(),
                updated_at: apple_reference_time(),
            }),
            peers: Mutex::new(HashMap::new()),
            commands: Mutex::new(Vec::new()),
            routes: Mutex::new(HashMap::new()),
            service_routes: Mutex::new(HashMap::new()),
            discovered: Mutex::new(HashMap::new()),
            connections: Mutex::new(Vec::new()),
            mdns,
        });
        *self
            .0
            .lock()
            .map_err(|_| "Splice Connect state is unavailable.".to_string())? =
            Some(runtime.clone());
        start_listener(runtime.clone(), listener);
        start_browser(runtime.clone(), instance_name)?;
        start_heartbeat(runtime);
        Ok(())
    }

    pub(crate) fn stop(&self) {
        let runtime = self.0.lock().ok().and_then(|mut value| value.take());
        if let Some(runtime) = runtime {
            runtime.alive.store(false, Ordering::Relaxed);
            let _ = runtime.mdns.shutdown();
        }
    }

    fn runtime(&self) -> Option<Arc<Runtime>> {
        self.0.lock().ok().and_then(|value| value.clone())
    }
}

#[tauri::command]
pub(crate) fn publish_connect_playback(
    playback: ConnectPlayback,
    state: tauri::State<'_, SpliceConnectState>,
) -> Result<(), String> {
    let Some(runtime) = state.runtime() else {
        return Ok(());
    };
    let mut peer = runtime
        .local_peer
        .lock()
        .map_err(|_| "Splice Connect playback is unavailable.".to_string())?;
    peer.playback = playback;
    peer.updated_at = apple_reference_time();
    drop(peer);
    broadcast_state(&runtime);
    Ok(())
}

#[tauri::command]
pub(crate) fn connect_snapshot(state: tauri::State<'_, SpliceConnectState>) -> ConnectSnapshot {
    let Some(runtime) = state.runtime() else {
        return ConnectSnapshot {
            is_available: false,
            local_device_id: None,
            peers: Vec::new(),
            commands: Vec::new(),
        };
    };
    let cutoff = Instant::now() - Duration::from_secs(12);
    let mut peers = runtime
        .peers
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    peers.retain(|_, entry| entry.received_at >= cutoff);
    let mut values: Vec<_> = peers.values().map(|entry| entry.peer.clone()).collect();
    values.sort_by(|left, right| {
        right
            .playback
            .is_playing
            .cmp(&left.playback.is_playing)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    let commands = runtime
        .commands
        .lock()
        .map(|mut commands| commands.drain(..).collect())
        .unwrap_or_default();
    let local_device_id = runtime.local_peer.lock().ok().map(|peer| peer.id.clone());
    ConnectSnapshot {
        is_available: runtime.alive.load(Ordering::Relaxed),
        local_device_id,
        peers: values,
        commands,
    }
}

#[tauri::command]
pub(crate) fn send_connect_command(
    peer_id: String,
    command: ConnectCommand,
    state: tauri::State<'_, SpliceConnectState>,
) -> Result<(), String> {
    let runtime = state
        .runtime()
        .ok_or_else(|| "Splice Connect is not available.".to_string())?;
    let route = runtime
        .routes
        .lock()
        .map_err(|_| "Splice Connect routes are unavailable.".to_string())?
        .get(&peer_id)
        .cloned()
        .ok_or_else(|| "That device is no longer connected.".to_string())?;
    send_wire(
        &route,
        &WireMessage {
            kind: "command".to_string(),
            authentication: runtime.authentication.clone(),
            peer: None,
            command: Some(command),
        },
    )
}

fn start_listener(runtime: Arc<Runtime>, listener: TcpListener) {
    thread::spawn(move || {
        while runtime.alive.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, _)) => adopt_stream(runtime.clone(), stream, None),
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(160))
                }
                Err(_) => thread::sleep(Duration::from_millis(500)),
            }
        }
    });
}

fn start_browser(runtime: Arc<Runtime>, local_instance: String) -> Result<(), String> {
    let receiver = runtime
        .mdns
        .browse(SERVICE_TYPE)
        .map_err(|error| format!("Splice Connect could not browse for devices: {error}"))?;
    thread::spawn(move || {
        while runtime.alive.load(Ordering::Relaxed) {
            match receiver.recv_timeout(Duration::from_secs(1)) {
                Ok(ServiceEvent::ServiceResolved(service)) => {
                    let fullname = service.get_fullname().to_string();
                    if fullname.starts_with(&format!("{local_instance}.")) {
                        continue;
                    }
                    let Some(address) = service
                        .get_addresses()
                        .iter()
                        .find(|address| address.is_ipv4())
                        .or_else(|| service.get_addresses().iter().next())
                    else {
                        continue;
                    };
                    let socket = SocketAddr::new(address.to_ip_addr(), service.get_port());
                    if let Ok(mut discovered) = runtime.discovered.lock() {
                        discovered.insert(
                            fullname,
                            DiscoveredService {
                                socket,
                                last_attempt: Instant::now() - Duration::from_secs(10),
                            },
                        );
                    }
                }
                Ok(ServiceEvent::ServiceRemoved(_, fullname)) => {
                    if let Ok(mut discovered) = runtime.discovered.lock() {
                        discovered.remove(&fullname);
                    }
                    if let Ok(mut routes) = runtime.service_routes.lock() {
                        routes.remove(&fullname);
                    }
                }
                _ => {}
            }

            let connected = runtime
                .service_routes
                .lock()
                .map(|routes| routes.clone())
                .unwrap_or_default();
            let live_peers = runtime
                .peers
                .lock()
                .map(|peers| peers.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            let mut attempts = Vec::new();
            if let Ok(mut discovered) = runtime.discovered.lock() {
                for (fullname, service) in discovered.iter_mut() {
                    let is_connected = connected
                        .get(fullname)
                        .is_some_and(|peer_id| live_peers.contains(peer_id));
                    if !is_connected && service.last_attempt.elapsed() >= Duration::from_secs(3) {
                        service.last_attempt = Instant::now();
                        attempts.push((fullname.clone(), service.socket));
                    }
                }
            }
            for (fullname, socket) in attempts {
                if let Ok(stream) = TcpStream::connect_timeout(&socket, Duration::from_secs(2)) {
                    adopt_stream(runtime.clone(), stream, Some(fullname));
                }
            }
        }
    });
    Ok(())
}

fn start_heartbeat(runtime: Arc<Runtime>) {
    thread::spawn(move || {
        while runtime.alive.load(Ordering::Relaxed) {
            broadcast_state(&runtime);
            thread::sleep(Duration::from_secs(3));
        }
    });
}

fn adopt_stream(runtime: Arc<Runtime>, stream: TcpStream, source: Option<String>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let Ok(writer_stream) = stream.try_clone() else {
        return;
    };
    let writer = Arc::new(Mutex::new(writer_stream));
    if let Ok(mut connections) = runtime.connections.lock() {
        if connections.len() >= MAX_CONNECTIONS {
            return;
        }
        connections.push(writer.clone());
    }
    send_state(&runtime, &writer);
    thread::spawn(move || read_connection(runtime, stream, writer, source));
}

fn read_connection(
    runtime: Arc<Runtime>,
    mut stream: TcpStream,
    writer: Arc<Mutex<TcpStream>>,
    source: Option<String>,
) {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 65_536];
    while runtime.alive.load(Ordering::Relaxed) {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => {
                buffer.extend_from_slice(&chunk[..count]);
                while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
                    let frame: Vec<_> = buffer.drain(..=newline).collect();
                    if let Ok(message) = serde_json::from_slice::<WireMessage>(
                        &frame[..frame.len().saturating_sub(1)],
                    ) {
                        handle_wire(&runtime, &writer, source.as_deref(), message);
                    }
                }
                if buffer.len() > 262_144 {
                    buffer.clear()
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                ) =>
            {
                continue
            }
            Err(_) => break,
        }
    }
    if let Ok(mut connections) = runtime.connections.lock() {
        connections.retain(|candidate| !Arc::ptr_eq(candidate, &writer));
    }
    if let Ok(mut routes) = runtime.routes.lock() {
        routes.retain(|_, candidate| !Arc::ptr_eq(candidate, &writer));
    }
    if let Some(source) = source {
        if let Ok(mut routes) = runtime.service_routes.lock() {
            routes.remove(&source);
        }
    }
}

fn handle_wire(
    runtime: &Arc<Runtime>,
    writer: &Arc<Mutex<TcpStream>>,
    source: Option<&str>,
    message: WireMessage,
) {
    if message.authentication != runtime.authentication {
        return;
    }
    match message.kind.as_str() {
        "state" => {
            let Some(mut peer) = message.peer else { return };
            let local_id = runtime.local_peer.lock().ok().map(|local| local.id.clone());
            if local_id.as_deref() == Some(peer.id.as_str()) {
                if let Ok(stream) = writer.lock() {
                    let _ = stream.shutdown(Shutdown::Both);
                }
                return;
            }
            if !valid_peer(&peer) {
                return;
            }
            peer.updated_at = apple_reference_time();
            if let Ok(mut peers) = runtime.peers.lock() {
                peers.insert(
                    peer.id.clone(),
                    PeerEntry {
                        peer: peer.clone(),
                        received_at: Instant::now(),
                    },
                );
            }
            if let Ok(mut routes) = runtime.routes.lock() {
                routes.insert(peer.id.clone(), writer.clone());
            }
            if let Some(source) = source {
                if let Ok(mut routes) = runtime.service_routes.lock() {
                    routes.insert(source.to_string(), peer.id);
                }
            }
        }
        "command" => {
            if let Some(command) = message.command {
                if !valid_command(&command) {
                    return;
                }
                if let Ok(mut commands) = runtime.commands.lock() {
                    if commands.len() >= MAX_PENDING_COMMANDS {
                        let overflow = commands.len() - MAX_PENDING_COMMANDS + 1;
                        commands.drain(..overflow);
                    }
                    commands.push(command)
                }
                broadcast_state(runtime);
            }
        }
        _ => {}
    }
}

fn valid_peer(peer: &ConnectPeer) -> bool {
    !peer.id.is_empty()
        && peer.id.len() <= 128
        && !peer.name.is_empty()
        && peer.name.len() <= 256
        && peer.platform.len() <= 64
        && peer.playback.position.is_finite()
        && peer.playback.position >= 0.0
        && peer.playback.duration.is_finite()
        && peer.playback.duration >= 0.0
}

fn valid_command(command: &ConnectCommand) -> bool {
    let shape_valid = match command.name.as_str() {
        "play" | "pause" | "toggle" | "previous" | "next" => true,
        "seek" => command
            .value
            .is_some_and(|value| value.is_finite() && value >= 0.0),
        "handoff" => command.handoff.as_ref().is_some_and(valid_handoff),
        "groupJoin" => command
            .group_join
            .as_ref()
            .is_some_and(|join| valid_group(&join.group) && valid_handoff(&join.handoff)),
        "groupSync" | "groupLeave" => command.group.as_ref().is_some_and(valid_group),
        _ => false,
    };
    shape_valid
}

fn valid_handoff(handoff: &ConnectHandoff) -> bool {
    !handoff.current_track_id.is_empty()
        && handoff.current_track_id.len() <= 1_024
        && !handoff.track_ids.is_empty()
        && handoff.track_ids.len() <= MAX_HANDOFF_TRACKS
        && handoff
            .track_ids
            .iter()
            .all(|id| !id.is_empty() && id.len() <= 1_024)
        && handoff.position.is_finite()
        && handoff.position >= 0.0
}

fn valid_group(group: &ConnectGroup) -> bool {
    !group.id.is_empty()
        && group.id.len() <= 128
        && !group.leader_id.is_empty()
        && group.leader_id.len() <= 128
        && !group.track_id.is_empty()
        && group.track_id.len() <= 1_024
        && group.position.is_finite()
        && group.position >= 0.0
        && group.sent_at.is_finite()
        && group.sent_at >= 0.0
}

fn broadcast_state(runtime: &Arc<Runtime>) {
    let mut connections = runtime
        .connections
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    connections.retain(|connection| send_state(runtime, connection));
}

fn send_state(runtime: &Arc<Runtime>, connection: &Arc<Mutex<TcpStream>>) -> bool {
    let peer = match runtime.local_peer.lock() {
        Ok(mut peer) => {
            peer.updated_at = apple_reference_time();
            peer.clone()
        }
        Err(_) => return false,
    };
    send_wire(
        connection,
        &WireMessage {
            kind: "state".to_string(),
            authentication: runtime.authentication.clone(),
            peer: Some(peer),
            command: None,
        },
    )
    .is_ok()
}

fn send_wire(connection: &Arc<Mutex<TcpStream>>, message: &WireMessage) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(message)
        .map_err(|_| "Splice Connect could not encode a message.".to_string())?;
    bytes.push(b'\n');
    connection
        .lock()
        .map_err(|_| "Splice Connect lost the device connection.".to_string())?
        .write_all(&bytes)
        .map_err(|error| format!("Splice Connect could not send to that device: {error}"))
}

/// Read from the Keychain at most once per process.
///
/// This is a second Keychain item alongside the saved credentials, and both
/// dialogs name the same service, so a user cannot tell them apart — they only
/// see Splice asking again. `configure` runs on connect, on session restore and
/// on every profile switch, so without this the device id was re-read each
/// time. The value is a stable per-install identifier, so one read is all it
/// can ever need.
static DEVICE_ID: OnceLock<String> = OnceLock::new();
static DEVICE_ID_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Set once at startup, where the app data directory is known.
pub(crate) fn set_device_id_path(path: PathBuf) {
    let _ = DEVICE_ID_PATH.set(path);
}

fn persistent_device_id() -> String {
    DEVICE_ID.get_or_init(load_persistent_device_id).clone()
}

/// A LAN identifier, not a secret.
///
/// Keeping it in the Keychain bought no protection and cost a second macOS
/// permission dialog, so it lives beside the rest of the app's data instead.
/// Older installs simply receive a new Connect identity the first time this
/// file-backed version runs; avoiding an unexplained password prompt is more
/// important than preserving an internal peer identifier.
fn load_persistent_device_id() -> String {
    if let Some(path) = DEVICE_ID_PATH.get() {
        if let Ok(saved) = std::fs::read_to_string(path) {
            let saved = saved.trim();
            if !saved.is_empty() {
                return saved.to_string();
            }
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    if let Some(path) = DEVICE_ID_PATH.get() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, &id);
    }
    id
}

fn apple_reference_time() -> f64 {
    let unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();
    unix - 978_307_200.0
}

pub(crate) fn fingerprint(server: &str, username: &str, password: &str) -> String {
    let raw = server.trim();
    let candidate = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    let normalized = Url::parse(&candidate)
        .ok()
        .map(|url| {
            let host = url.host_str().unwrap_or(raw).to_lowercase();
            let port = url
                .port()
                .map(|value| format!(":{value}"))
                .unwrap_or_default();
            let mut path = url.path().trim_end_matches('/').to_lowercase();
            if path.ends_with("/rest") {
                path.truncate(path.len() - 5)
            }
            format!("{host}{port}{path}")
        })
        .unwrap_or_else(|| raw.to_lowercase());
    let digest =
        Sha256::digest(format!("{normalized}|{}|{password}", username.to_lowercase()).as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::{
        fingerprint, ConnectCommand, ConnectGroup, ConnectGroupJoin, ConnectHandoff, WireMessage,
    };

    #[test]
    fn fingerprint_matches_the_mobile_normalization_contract() {
        assert_eq!(
            fingerprint(
                "https://Music.Example.test:4533/navidrome/rest/",
                "TestUser",
                "correct horse"
            ),
            "88dd0e47cc9415102a62af212766772e6f553012eefd758fe5cf635011b18c72"
        );
        assert_eq!(
            fingerprint(
                "music.example.test:4533/navidrome",
                "testuser",
                "correct horse"
            ),
            "88dd0e47cc9415102a62af212766772e6f553012eefd758fe5cf635011b18c72"
        );
    }

    #[test]
    fn command_frames_omit_unused_optional_fields() {
        let frame = WireMessage {
            kind: "command".to_string(),
            authentication: "fingerprint".to_string(),
            peer: None,
            command: Some(ConnectCommand {
                name: "pause".to_string(),
                value: None,
                handoff: None,
                group: None,
                group_join: None,
            }),
        };
        assert_eq!(
            serde_json::to_value(frame).unwrap(),
            serde_json::json!({
                "kind": "command", "authentication": "fingerprint", "command": { "name": "pause" }
            })
        );
        let handoff = ConnectCommand {
            name: "handoff".to_string(),
            value: None,
            handoff: Some(ConnectHandoff {
                track_ids: vec!["one".into(), "two".into()],
                current_track_id: "two".into(),
                position: 42.25,
                is_playing: true,
            }),
            group: None,
            group_join: None,
        };
        assert_eq!(
            serde_json::to_value(handoff).unwrap()["handoff"]["currentTrackId"],
            "two"
        );

        let group = ConnectGroup {
            id: "room".into(),
            leader_id: "desktop".into(),
            track_id: "two".into(),
            position: 42.25,
            is_playing: true,
            sent_at: 1_800_000_000_000.0,
        };
        let join = ConnectCommand {
            name: "groupJoin".into(),
            value: None,
            handoff: None,
            group: None,
            group_join: Some(ConnectGroupJoin {
                group,
                handoff: ConnectHandoff {
                    track_ids: vec!["one".into(), "two".into()],
                    current_track_id: "two".into(),
                    position: 42.25,
                    is_playing: true,
                },
            }),
        };
        let value = serde_json::to_value(join).unwrap();
        assert_eq!(value["name"], "groupJoin");
        assert_eq!(value["groupJoin"]["group"]["leaderId"], "desktop");
        assert_eq!(value["groupJoin"]["handoff"]["trackIds"][1], "two");
    }
}
