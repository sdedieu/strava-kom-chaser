import { DocumentReference } from '@angular/fire/firestore';

const DURATIONS = [
  1, 5, 10, 15, 30, 45, 60, 90, 120, 180, 300, 600, 900, 1200, 1800, 3600, 5400,
  7200,
] as const;

export type Athlete = {
  id: number;
  username: string;
  firstname: string;
  lastname: string;
  city: string;
  state: string;
  country: string | null;
  sex: string;
  premium: boolean;
  created_at: string;
  updated_at: string;
  badge_type_id: number;
  profile_medium: string;
  profile: string;
  athlete_type: number;
  date_preference: string;
  measurement_preference: string;
  ftp: number | null;
  weight: number;
  bikes: any;
  clubs: any;
  follower: any;
  follower_count: any;
  friend: any;
  friend_count: any;
  mutual_friend_count: any;
  postable_clubs_count: any;
  shoes: any;
};

export type Token = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
};

export type RequestWithAuth = {
  auth?: {
    uid?: string;
  };
};

export type AthleteProfile = {
  athlete: Athlete;
  zones: {
    [key: string]: { zones: { max: number; min: number; time: number }[] };
  };
};

export type Effort = {
  id: string;
  moving_time: number;
  pr_rank: null;
  start_date_local: string;
  average_watts: number;
  athlete: {
    id_str: string;
    resource_state: number;
    id: number;
  };
  name: string;
  activity: {
    id: number;
    resource_state: number;
    id_str: string;
    visibility: string;
  };
  elapsed_time: number;
  resource_state: number;
  kom_rank: null;
  visibility: 'everyone';
  end_index: number;
  segmentId: number;
  start_index: number;
  average_heartrate: number;
  hidden: boolean;
  max_heartrate: number;
  device_watts: boolean;
  achievements: [];
  average_cadence: number;
  distance: number;
  start_date: string;
};

export type Activity = {
  id: number;
  resource_state?: number;
  sport_type?: string;
  type?: string;
  segment_efforts?: Effort[];
};

export type ActivityStreamKey = 'time' | 'heartrate' | 'watts' | 'distance';

export type ActivityStream = {
  [key in ActivityStreamKey]: {
    data: number[];
    series_type: string;
    original_size: number;
    resolution: string;
  };
};

export type PowerCurveDuration = (typeof DURATIONS)[number];

export type ActivityPowerCurve = Partial<Record<PowerCurveDuration, number>>;

export type RawSegmentXoms = {
  kom?: string;
  qom?: string;
  overall?: string;
};

export type SegmentXoms = {
  kom?: number;
  qom?: number;
  overall?: number;
};

export type Segment = {
  id: string;
  athlete_segment_stats?: any;
  local_legend?: any;
  elevation_profile?: string;
  elevation_profiles?: any;
  xoms: SegmentXoms;
  resource_state: number;
  name: string;
  activity_type: string;
  distance: number;
  average_grade: number;
  maximum_grade: number;
  elevation_high: number;
  elevation_low: number;
  start_latlng: [number, number];
  end_latlng: [number, number];
  climb_category: number;
  city: string;
  state: string;
  country: string;
  private: boolean;
  hazardous: boolean;
  created_at: string;
  updated_at: string;
  total_elevation_gain: number;
  map: {
    id: string;
    polyline: string;
    resource_state: number;
  };
  effort_count: number;
  athlete_count: number;
  star_count: number;
};

export type StravaSegment = Omit<Segment, 'xoms'> & {
  xoms: RawSegmentXoms;
};

export type SegmentTimePrediction = {
  timeSeconds: number;
  timeMinutes: number;
  speedMps: number;
  speedKmh: number;
  estimatedPowerW: number;
  riderWeightKg: number;
  confidence: {
    score: number;
    label: 'low' | 'medium' | 'high';
    reasons: string[];
  };
};

export type SegmentScore = {
  confidence: {
    score: number;
    label: 'low' | 'medium' | 'high';
    reasons: string[];
  };
  estimatedPowerNeeded: number;
  estimatedTimeDiff: number;
};

export type AthleteSegment = Segment & {
  score: SegmentScore;
  segment: any;
  updatedAt: any;
};

export type SegmentTimePredictionOptions = {
  /** Used only when Strava reports weight as 0/null. */
  fallbackRiderWeightKg?: number;
  bikeAndEquipmentWeightKg?: number;
  cda?: number;
  crr?: number;
  airDensityKgM3?: number;
  drivetrainEfficiency?: number;
  /** Discounts best recorded power when conditions may not be repeatable. */
  powerCurveRealizationFactor?: number;
  /** @deprecated Use powerCurveRealizationFactor instead. */
  histogramRealizationFactor?: number;
  /** Descebding speed above which applided power starts deceaseing. */
  descentPowerTaperStartKmh?: number;
  /** Descending speed at which the model assumes the rider stops pedalling. */
  descentCoastingKmh?: number;
};

export type PowerCurvePoint = {
  durationSeconds: number;
  powerW: number;
};
