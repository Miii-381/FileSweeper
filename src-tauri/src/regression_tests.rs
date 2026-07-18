use super::*;

fn test_directory(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "video-sweeper-regression-{name}-{}-{}",
        std::process::id(),
        current_unix_millis()
    ));
    fs::create_dir_all(&directory).expect("test directory should be created");
    directory
}

fn cache_entry(
    source: &Path,
    thumbnail_file: &str,
    last_accessed_at: u128,
    metadata: Option<CachedMediaMetadata>,
) -> MediaCacheEntry {
    let source_metadata = fs::metadata(source).expect("source metadata should be readable");
    MediaCacheEntry {
        size: source_metadata.len(),
        modified_at: unix_millis(source_metadata.modified()).unwrap_or(0),
        thumbnail: Some(CachedThumbnail {
            capture_position: thumbnail_capture_cache_key("middle").to_string(),
            thumbnail_file: thumbnail_file.to_string(),
            last_accessed_at,
        }),
        metadata,
    }
}

#[test]
fn background_sidecar_default_uses_two_thirds_of_logical_cpus() {
    assert_eq!(background_sidecar_concurrency_for(1), 1);
    assert_eq!(background_sidecar_concurrency_for(2), 1);
    assert_eq!(background_sidecar_concurrency_for(4), 2);
    assert_eq!(background_sidecar_concurrency_for(8), 5);
    assert_eq!(background_sidecar_concurrency_for(32), 21);
}

#[test]
fn fixed_sidecar_pool_resizes_without_cancelling_in_flight_work() {
    let pool = Arc::new(MediaSidecarPermits::new(3));
    let first = pool.acquire().unwrap();
    let second = pool.acquire().unwrap();
    pool.set_limit(1).unwrap();
    assert_eq!(pool.limit().unwrap(), 1);
    drop(first);
    drop(second);
    pool.set_limit(4).unwrap();
    assert_eq!(pool.limit().unwrap(), 4);
}

#[test]
fn configuration_clamps_background_sidecar_concurrency_to_this_machine() {
    let mut below_minimum = AppConfig::default();
    below_minimum.settings.background_sidecar_concurrency = 0;
    config_store::validate_config(&mut below_minimum).unwrap();
    assert_eq!(below_minimum.settings.background_sidecar_concurrency, 1);

    let mut above_maximum = AppConfig::default();
    above_maximum.settings.background_sidecar_concurrency = usize::MAX;
    config_store::validate_config(&mut above_maximum).unwrap();
    assert_eq!(
        above_maximum.settings.background_sidecar_concurrency,
        available_parallelism()
    );
}

#[test]
fn fixed_sidecar_pool_never_exceeds_its_limit() {
    use std::sync::atomic::AtomicUsize;

    let pool = Arc::new(MediaSidecarPermits::new(2));
    let active = Arc::new(AtomicUsize::new(0));
    let maximum = Arc::new(AtomicUsize::new(0));
    let workers = (0..8)
        .map(|_| {
            let pool = Arc::clone(&pool);
            let active = Arc::clone(&active);
            let maximum = Arc::clone(&maximum);
            thread::spawn(move || {
                let _permit = pool.acquire().unwrap();
                let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                maximum.fetch_max(now, Ordering::SeqCst);
                thread::sleep(Duration::from_millis(20));
                active.fetch_sub(1, Ordering::SeqCst);
            })
        })
        .collect::<Vec<_>>();
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(maximum.load(Ordering::SeqCst), 2);
}

#[test]
fn background_sidecar_retry_budget_is_three_total_attempts() {
    let pool = Arc::new(MediaSidecarPermits::new(1));
    let attempts = AtomicU64::new(0);
    let result = media_processing::run_background_sidecar_with_retries(&pool, "test", || {
        let attempt = attempts.fetch_add(1, Ordering::SeqCst) + 1;
        if attempt < 3 {
            Err("transient".to_string())
        } else {
            Ok("done")
        }
    });
    assert_eq!(result.unwrap(), "done");
    assert_eq!(attempts.load(Ordering::SeqCst), 3);
}

#[test]
fn background_sidecar_releases_its_permit_between_retries() {
    let pool = Arc::new(MediaSidecarPermits::new(1));
    let attempts = Arc::new(AtomicU64::new(0));
    let (first_attempt_sender, first_attempt_receiver) = mpsc::channel();
    let worker_pool = Arc::clone(&pool);
    let worker_attempts = Arc::clone(&attempts);
    let worker = thread::spawn(move || {
        media_processing::run_background_sidecar_with_retries(&worker_pool, "test", || {
            let attempt = worker_attempts.fetch_add(1, Ordering::SeqCst) + 1;
            if attempt == 1 {
                first_attempt_sender.send(()).unwrap();
                Err("retry".to_string())
            } else {
                Ok(())
            }
        })
    });

    first_attempt_receiver.recv().unwrap();
    let intervening_permit = pool.acquire().unwrap();
    thread::sleep(Duration::from_millis(150));
    drop(intervening_permit);
    worker.join().unwrap().unwrap();
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
}

#[test]
fn media_cache_migrates_legacy_thumbnail_entries() {
    let directory = test_directory("legacy-media-cache");
    let source = directory.join("sample.mp4");
    fs::write(&source, b"video").unwrap();
    let source_metadata = fs::metadata(&source).unwrap();
    let legacy = serde_json::json!({
        "entries": {
            path_string(&source): {
                "size": source_metadata.len(),
                "modifiedAt": unix_millis(source_metadata.modified()).unwrap_or(0),
                "capturePosition": "v2:middle",
                "thumbnailFile": "0123456789abcdef.jpg",
                "lastAccessedAt": 42
            }
        }
    });
    fs::write(
        thumbnail_index_path_for(&directory),
        serde_json::to_vec_pretty(&legacy).unwrap(),
    )
    .unwrap();

    let index = load_thumbnail_index_from(&directory);
    assert_eq!(index.version, MEDIA_CACHE_VERSION);
    let entry = index.entries.get(&path_string(&source)).unwrap();
    assert!(entry.thumbnail.is_some());
    assert!(entry.metadata.is_none());
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn thumbnail_eviction_preserves_persisted_metadata() {
    let directory = test_directory("metadata-survives-eviction");
    let first_source = directory.join("first.mp4");
    let second_source = directory.join("second.mp4");
    fs::write(&first_source, b"first").unwrap();
    fs::write(&second_source, b"second").unwrap();
    fs::write(directory.join("old.jpg"), [1_u8; 8]).unwrap();
    fs::write(directory.join("new.jpg"), [2_u8; 8]).unwrap();
    fs::write(directory.join("0123456789abcdef.jpg"), [3_u8; 8]).unwrap();
    fs::write(directory.join("in-progress.tmp.jpg"), [4_u8; 8]).unwrap();

    let index = Arc::new(Mutex::new(MediaCacheIndex::default()));
    let cache_maintenance_lock = Arc::new(Mutex::new(()));
    let first_access = current_unix_millis().saturating_add(1);
    index.lock().unwrap().entries.insert(
        path_string(&first_source),
        cache_entry(
            &first_source,
            "old.jpg",
            first_access,
            Some(CachedMediaMetadata {
                duration: Some(12.0),
                width: Some(1920),
                height: Some(1080),
            }),
        ),
    );
    index.lock().unwrap().entries.insert(
        path_string(&second_source),
        cache_entry(&second_source, "new.jpg", first_access + 1, None),
    );

    maintain_thumbnail_cache(&directory, &index, &cache_maintenance_lock, 8).unwrap();
    let index = index.lock().unwrap();
    let first = index.entries.get(&path_string(&first_source)).unwrap();
    assert!(first.thumbnail.is_none());
    assert_eq!(
        first.metadata.as_ref().and_then(|value| value.duration),
        Some(12.0)
    );
    assert!(!directory.join("old.jpg").exists());
    assert!(!directory.join("0123456789abcdef.jpg").exists());
    assert!(directory.join("in-progress.tmp.jpg").exists());
    assert!(directory.join("new.jpg").exists());
    drop(index);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn corrupt_media_cache_index_is_backed_up_and_rebuilt() {
    let directory = test_directory("corrupt-media-cache");
    let index_path = thumbnail_index_path_for(&directory);
    fs::write(&index_path, b"not valid json").unwrap();
    let index = load_thumbnail_index_from(&directory);
    assert!(index.entries.is_empty());
    assert!(fs::read_dir(&directory)
        .unwrap()
        .filter_map(Result::ok)
        .any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("index-corrupt-")
        }));
    serde_json::from_slice::<MediaCacheIndex>(&fs::read(index_path).unwrap()).unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn log_poll_returns_content_only_when_hash_changes() {
    let path = Path::new("video-sweeper.log");
    let first = log_snapshot_from_bytes(path, b"first", None, 1024);
    assert!(first.changed);
    assert_eq!(first.content.as_deref(), Some("first"));
    let unchanged = log_snapshot_from_bytes(path, b"first", Some(&first.hash), 1024);
    assert!(!unchanged.changed);
    assert!(unchanged.content.is_none());
    let appended = log_snapshot_from_bytes(path, b"first\nsecond", Some(&first.hash), 6);
    assert!(appended.changed);
    assert_eq!(appended.content.as_deref(), Some("second"));
    let truncated = log_snapshot_from_bytes(path, b"new", Some(&appended.hash), 1024);
    assert!(truncated.changed);
    assert_eq!(truncated.content.as_deref(), Some("new"));
}

#[test]
fn transcode_registration_tracks_video_until_owner_is_dropped() {
    let controller = Arc::new(TranscodeController::new());
    let path = Path::new(r"D:\Videos\focused.mp4");
    let registration = controller.replace_with(42, path);
    assert_eq!(
        controller.active_process_path(42).as_deref(),
        Some(r"D:\Videos\focused.mp4")
    );
    drop(registration);
    assert!(controller.active_process_path(42).is_none());
}

#[test]
fn default_thumbnail_cache_limit_is_512_mebibytes() {
    assert_eq!(Preferences::default().thumbnail_cache_gb, 0.5);
    assert_eq!(thumbnail_cache_limit_bytes(0.5), 512 * MEBIBYTE);
}
