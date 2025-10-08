-- ========== MariaDB 10.4.32 SCHEMA (no SRID, no history) ==========

-- USERS
CREATE TABLE users (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  role             ENUM('USER','RIDER') NOT NULL,
  phone            VARCHAR(32) NOT NULL UNIQUE,
  username         VARCHAR(50) NOT NULL UNIQUE,
  password_hash    VARCHAR(255) NOT NULL,
  name             VARCHAR(140) NOT NULL,
  avatar_path      TEXT,                           -- path/URL ของรูปโปรไฟล์
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- RIDER PROFILE
CREATE TABLE rider_profiles (
  user_id            BIGINT UNSIGNED PRIMARY KEY,
  vehicle_plate      VARCHAR(64) NOT NULL,
  vehicle_model      VARCHAR(120),
  vehicle_photo_path TEXT,
  is_active          TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT fk_rider_profiles_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE UNIQUE INDEX uniq_vehicle_plate ON rider_profiles(vehicle_plate);

-- ADDRESSES (มี default ได้ที่เดียว/ผู้ใช้ โดยใช้ generated column)
CREATE TABLE addresses (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id          BIGINT UNSIGNED NOT NULL,
  label            VARCHAR(120),
  address_text     TEXT NOT NULL,
  lat              DOUBLE NOT NULL,
  lng              DOUBLE NOT NULL,
  is_default       TINYINT(1) NOT NULL DEFAULT 0,
  default_owner    BIGINT UNSIGNED AS (IF(is_default, user_id, NULL)) VIRTUAL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_addresses_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX idx_addresses_user ON addresses(user_id);
CREATE UNIQUE INDEX uniq_default_address_per_user ON addresses(default_owner);

-- SHIPMENTS
CREATE TABLE shipments (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  title                VARCHAR(200) NOT NULL,  
  sender_id            BIGINT UNSIGNED NOT NULL,
  receiver_id          BIGINT UNSIGNED NOT NULL,
  pickup_address_id    BIGINT UNSIGNED NOT NULL,
  dropoff_address_id   BIGINT UNSIGNED NOT NULL,
  status ENUM('WAITING_FOR_RIDER','RIDER_ACCEPTED','PICKED_UP_EN_ROUTE','DELIVERED')
         NOT NULL DEFAULT 'WAITING_FOR_RIDER',
  status_updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note                 TEXT,
  CONSTRAINT fk_ship_sender   FOREIGN KEY (sender_id)   REFERENCES users(id)     ON DELETE RESTRICT,
  CONSTRAINT fk_ship_receiver FOREIGN KEY (receiver_id) REFERENCES users(id)     ON DELETE RESTRICT,
  CONSTRAINT fk_ship_pickup   FOREIGN KEY (pickup_address_id)  REFERENCES addresses(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ship_dropoff  FOREIGN KEY (dropoff_address_id) REFERENCES addresses(id) ON DELETE RESTRICT
) ENGINE=InnoDB;
CREATE INDEX idx_shipments_sender   ON shipments(sender_id);
CREATE INDEX idx_shipments_receiver ON shipments(receiver_id);
CREATE INDEX idx_shipments_status   ON shipments(status);

-- ITEMS
CREATE TABLE shipment_items (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  shipment_id   BIGINT UNSIGNED NOT NULL,
  name          VARCHAR(200) NOT NULL,
  qty           INT NOT NULL DEFAULT 1,
  note          TEXT,
  CONSTRAINT fk_items_shipment FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX idx_items_shipment ON shipment_items(shipment_id);

-- STATUS HISTORY (ยังแนะนำให้มีไว้ออดิท/Realtime; ถ้าอยากลดขนาด ค่อยตั้ง retention ลบเก่าเป็น batch)
CREATE TABLE shipment_status_history (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  shipment_id   BIGINT UNSIGNED NOT NULL,
  status ENUM('WAITING_FOR_RIDER','RIDER_ACCEPTED','PICKED_UP_EN_ROUTE','DELIVERED') NOT NULL,
  actor_user_id BIGINT UNSIGNED,
  at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note          TEXT,
  CONSTRAINT fk_hist_shipment FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE,
  CONSTRAINT fk_hist_actor    FOREIGN KEY (actor_user_id) REFERENCES users(id)     ON DELETE SET NULL
) ENGINE=InnoDB;
CREATE INDEX idx_hist_shipment ON shipment_status_history(shipment_id);

-- ASSIGNMENTS (ไรเดอร์ถือได้ทีละงาน)
CREATE TABLE rider_assignments (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  shipment_id   BIGINT UNSIGNED NOT NULL,
  rider_id      BIGINT UNSIGNED NOT NULL,
  accepted_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  picked_up_at  TIMESTAMP NULL,
  delivered_at  TIMESTAMP NULL,
  active_owner  BIGINT UNSIGNED AS (IF(delivered_at IS NULL, rider_id, NULL)) VIRTUAL,
  CONSTRAINT fk_assignment_shipment FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE,
  CONSTRAINT fk_assignment_rider    FOREIGN KEY (rider_id)    REFERENCES users(id)    ON DELETE RESTRICT,
  CONSTRAINT uniq_assignment_per_shipment UNIQUE (shipment_id)
) ENGINE=InnoDB;
CREATE UNIQUE INDEX uniq_active_job_per_rider ON rider_assignments(active_owner);

-- PHOTOS -> เก็บเป็น "ไฟล์" (path/URL + meta) 
CREATE TABLE shipment_files (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  shipment_id   BIGINT UNSIGNED NOT NULL,
  uploaded_by   BIGINT UNSIGNED NOT NULL,
  stage ENUM('WAITING_FOR_RIDER','PICKED_UP_EN_ROUTE','DELIVERED') NOT NULL,
  file_path     TEXT NOT NULL,            -- พาธไฟล์ในระบบ/URL object storage
  -- mime_type     VARCHAR(100),
  -- file_size     BIGINT UNSIGNED,          -- bytes (optional)
  -- checksum_sha256 CHAR(64),               -- สำหรับ dedupe/verify (optional)
  uploaded_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_file_ship FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE,
  CONSTRAINT fk_file_user FOREIGN KEY (uploaded_by)  REFERENCES users(id)    ON DELETE RESTRICT,
  CONSTRAINT uniq_one_file_per_stage UNIQUE (shipment_id, stage)
) ENGINE=InnoDB;

-- RIDER LAST-KNOWN LOCATION (ไม่มี history)
CREATE TABLE rider_locations (
  rider_id      BIGINT UNSIGNED PRIMARY KEY,
  lat           DOUBLE NOT NULL,
  lng           DOUBLE NOT NULL,
  heading_deg   DOUBLE,
  speed_mps     DOUBLE,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_rl_user FOREIGN KEY (rider_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ================== FUNCTIONS & TRIGGERS ==================
DELIMITER $$

-- ฟังก์ชัน Haversine (เมตร)
CREATE FUNCTION haversine_m(lat1 DOUBLE, lng1 DOUBLE, lat2 DOUBLE, lng2 DOUBLE)
RETURNS DOUBLE
DETERMINISTIC
BEGIN
  DECLARE r_earth DOUBLE DEFAULT 6371000.0; -- meters
  DECLARE dlat DOUBLE; DECLARE dlng DOUBLE;
  DECLARE a DOUBLE; DECLARE c DOUBLE;
  SET dlat = RADIANS(lat2 - lat1);
  SET dlng = RADIANS(lng2 - lng1);
  SET a = SIN(dlat/2)*SIN(dlat/2) +
          COS(RADIANS(lat1))*COS(RADIANS(lat2)) *
          SIN(dlng/2)*SIN(dlng/2);
  SET c = 2 * ATAN2(SQRT(a), SQRT(1-a));
  RETURN r_earth * c;
END$$

-- บังคับลำดับสถานะ
CREATE TRIGGER trg_shipments_status_guard
BEFORE UPDATE ON shipments
FOR EACH ROW
BEGIN
  DECLARE msg VARCHAR(255);
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'WAITING_FOR_RIDER' AND NEW.status IN ('RIDER_ACCEPTED')) OR
      (OLD.status = 'RIDER_ACCEPTED' AND NEW.status IN ('PICKED_UP_EN_ROUTE')) OR
      (OLD.status = 'PICKED_UP_EN_ROUTE' AND NEW.status IN ('DELIVERED')) OR
      (OLD.status = NEW.status)
    ) THEN
      SET msg = CONCAT('Invalid status transition: ', OLD.status, ' -> ', NEW.status);
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = msg;
    END IF;
  END IF;
END$$

-- เช็กระยะ 20m ตอนเปลี่ยนเป็น PICKED_UP_EN_ROUTE หรือ DELIVERED
CREATE TRIGGER trg_shipments_distance_guard
BEFORE UPDATE ON shipments
FOR EACH ROW
BEGIN
  DECLARE arider BIGINT UNSIGNED;
  DECLARE rlat DOUBLE; DECLARE rlng DOUBLE;
  DECLARE plat DOUBLE; DECLARE plng DOUBLE;
  DECLARE dlat DOUBLE; DECLARE dlng DOUBLE;
  DECLARE dist_m DOUBLE;

  IF NEW.status <> OLD.status THEN
    IF NEW.status IN ('PICKED_UP_EN_ROUTE','DELIVERED') THEN
      -- หา rider ที่กำลังถือ shipment นี้อยู่ (ยังไม่ delivered)
      SELECT ra.rider_id INTO arider
      FROM rider_assignments ra
      WHERE ra.shipment_id = NEW.id AND ra.delivered_at IS NULL
      LIMIT 1;

      IF arider IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'No active rider assignment for this shipment';
      END IF;

      -- ตำแหน่งล่าสุดของ rider
      SELECT lat, lng INTO rlat, rlng FROM rider_locations WHERE rider_id = arider LIMIT 1;
      IF rlat IS NULL OR rlng IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Rider location not available';
      END IF;

      IF NEW.status = 'PICKED_UP_EN_ROUTE' THEN
        SELECT a.lat, a.lng INTO plat, plng FROM addresses a WHERE a.id = NEW.pickup_address_id LIMIT 1;
        SET dist_m = haversine_m(rlat, rlng, plat, plng);
        IF dist_m > 20.0 THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Rider must be within 20m of pickup';
        END IF;
      END IF;

      IF NEW.status = 'DELIVERED' THEN
        SELECT a.lat, a.lng INTO plat, plng FROM addresses a WHERE a.id = NEW.dropoff_address_id LIMIT 1;
        SET dist_m = haversine_m(rlat, rlng, plat, plng);
        IF dist_m > 20.0 THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Rider must be within 20m of dropoff';
        END IF;
      END IF;
    END IF;
  END IF;
END$$

DELIMITER ;
