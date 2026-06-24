class Segment:
    """One ramp-and-hold step of a firing schedule, in canonical units.

    rate   - ramp rate in degrees per second (>= 0; the direction of the
             ramp is implied by target vs. the current setpoint, not by the
             sign of rate)
    target - temperature to ramp to
    hold   - soak time at target, in seconds
    """
    def __init__(self, rate, target, hold=0.0):
        self.rate = float(rate)      # deg/sec
        self.target = float(target)  # deg
        self.hold = float(hold)      # sec

    @property
    def rate_per_hour(self):
        return self.rate * 3600.0

    def __repr__(self):
        return "Segment(rate=%.4g/hr, target=%g, hold=%gs)" % (
            self.rate_per_hour, self.target, self.hold)


def rth_to_segments(rth):
    """Convert stored rate/temp/hold rows into canonical Segments.

    Each row is [rate_per_hour, target_temp, hold_hours] - the format the UI
    saves and parse_rate_temp_hold produces."""
    segments = []
    for row in rth:
        rate_per_hour, target, hold_hours = row[0], row[1], row[2]
        segments.append(Segment(rate=float(rate_per_hour) / 3600.0,
                                 target=float(target),
                                 hold=float(hold_hours) * 3600.0))
    return segments


def time_temp_to_segments(data):
    """Derive canonical Segments from time/temp points [[seconds, temp], ...].

    Each consecutive pair becomes a ramp segment (rate = |dT|/dt). A flat run
    (same temperature) becomes a hold; consecutive holds at the same
    temperature are merged onto the preceding segment."""
    points = sorted(data)
    segments = []
    for i in range(1, len(points)):
        t0, temp0 = points[i - 1]
        t1, temp1 = points[i]
        dt = t1 - t0
        if dt <= 0:
            continue
        if temp1 == temp0:
            if segments and segments[-1].target == temp1:
                segments[-1].hold += dt
            else:
                segments.append(Segment(rate=0.0, target=temp1, hold=dt))
        else:
            segments.append(Segment(rate=abs(temp1 - temp0) / dt, target=temp1))
    return segments


def segments_to_points(segments, start_temp):
    """Build time/temp points [[seconds, temp], ...] from Segments, for
    drawing the ideal curve and computing duration. A ramp that cannot move
    (rate 0 toward a different target) is treated as instantaneous."""
    t = 0.0
    temp = float(start_temp)
    points = [[0, temp]]
    for seg in segments:
        if seg.target != temp:
            if seg.rate > 0:
                t += abs(seg.target - temp) / seg.rate
            temp = seg.target
            points.append([int(round(t)), temp])
        if seg.hold > 0:
            t += seg.hold
            points.append([int(round(t)), temp])
    return points


def parse_rate_temp_hold(rate_temp_hold_text):
    rate_temp_hold = []
    for line in rate_temp_hold_text.strip().split("\n"):
        line = line.replace("hold", "")
        line = line.replace("to", "")
        line = line.replace("  ", " ")
        parts = line.split()
        if len(parts) != 3:
            raise ValueError(f"Invalid line format: {line}")

        rate = parts[0]
        if rate.endswith("/h"):
            rate = float(rate[:-2])
        elif rate.endswith("/m"):
            rate = float(rate[:-2]) / 60
        else:
            rate = float(rate)
        temp = float(parts[1])
        hold = parts[2]
        if hold.endswith("h"):
            hold = float(hold[:-1])
        elif hold.endswith("m"):
            hold = float(hold[:-1]) / 60
        else:
            hold = float(hold)

        rate_temp_hold.append([rate, temp, hold])
    return rate_temp_hold

def convert_to_time_temp(rate_temp_hold):
    accumulated_time = 0
    current_temp = 100
    time_temp_schedule = []
    for rate, temp, hold in rate_temp_hold:
        dt = abs(temp - current_temp) / rate
        accumulated_time += dt
        current_temp = temp
        time_temp_schedule.append((accumulated_time, temp))
        if hold > 0:
          accumulated_time += hold
          time_temp_schedule.append((accumulated_time, temp))
    return time_temp_schedule

def convert_to_rate_temp_hold(time_temp_schedule):
    rate_temp_schedule = []
    skip_next = False
    for i in range(len(time_temp_schedule)):
        if skip_next:
            skip_next = False
            continue

        if i == 0:
            t1 = [0,100]
            t2 = time_temp_schedule[i]
        else:
            t1 = time_temp_schedule[i-1]
            t2 = time_temp_schedule[i]

        dt = t2[0] - t1[0]
        dT = t2[1] - t1[1]
        rate = abs(dT / dt)

        hold = 0
        if dT == 0:
          hold = dt

        rate_temp_schedule.append([rate, t2[1], hold])
        #if dT != 0:
        #    skip_next = True

    # collapse 0 rate segments with holds at same temp
    for i in range(len(rate_temp_schedule)-1, 0, -1):
        if rate_temp_schedule[i][0] == 0 and rate_temp_schedule[i][1] == rate_temp_schedule[i-1][1]:
            rate_temp_schedule[i-1][2] = rate_temp_schedule[i][2]
            del(rate_temp_schedule[i])
    return rate_temp_schedule

def format_hold_time(hours):
    if hours < 1:
        hours *= 60
        hours = f'{hours:.0f}m'
    else:
        hours = f'{hours:.2f}h'
    return hours

def print_rate_temp_hold_schedule(schedule):
    for segment in schedule:
        hold = format_hold_time(segment[2])
        print(f"{segment[0]:.0f}°F/h to {segment[1]:.0f}°F hold {hold}")

def print_time_temp_schedule(schedule):
    for segment in schedule:
        print(f"{segment[0]*60:.0f} min -> {segment[1]} °F")

def dump_seconds_temp_schedule(schedule):
    pass

def read_seconds_temp_schedule(schedule):
    minutes_temp_schedule = [[x[0] / 60, x[1]] for x in schedule]
    return minutes_temp_schedule

if __name__ == "__main__":
    rate_temp_hold_text = """
    50/h to 450 hold 1h
    50/h to 1050 hold 2h
    50/h to 1250 hold 2h
    50/h to 1350 hold 2h
    50/h to 1465 hold 1h
    9999/h to 950 hold 4h
    30/h to 800 hold 15m
    50/h to 700 hold 10m
    250/h to 100 hold 1m
    """

    rate_temp_hold = [
      [50, 450, 1.0],
      [50, 1050, 2.0],
      [50, 1250, 2.0],
      [50, 1350, 2.0],
      [50, 1465, 10/60],
      [9999, 950, 4.0],
      [30, 800, 15/60],
      [50, 700, 10/60],
      [250, 100, 1/60]
    ]

    time_temp_schedule = [
        [60, 200], [2400, 250], [4200, 250], [15900, 1050], [17700, 1050], [20580, 1250], [21180, 1250], [22620, 1350], [23820, 1350], [25200, 1465], [25800, 1465], [25860, 950], [29400, 950], [35700, 800], [36300, 800], [44700, 100]
    ]
    tts = [(x[0]/(60*60), x[1]) for x in time_temp_schedule]
    rate_temp_schedule = convert_to_rate_temp_hold(tts)
    print("Rate-Temperature Schedule:")
    print_rate_temp_hold_schedule(rate_temp_schedule)


    # parsed_rate_temp_hold = parse_rate_temp_hold(rate_temp_hold_text)

    # for segment in parsed_rate_temp_hold:
    #     print(f"Rate: {segment[0]} °F/h, Temp: {segment[1]} °F, Hold: {segment[2]} h")

    # time_temp_schedule = convert_to_time_temp(parsed_rate_temp_hold)
    # print("Time-Temperature Schedule:")
    # for t in time_temp_schedule:
    #     print(f"{t[0]*60:.0f} min -> {t[1]} °F")

    # rate_temp_schedule = convert_to_rate_temp_hold(time_temp_schedule)
    # print("Rate-Temperature Schedule:")
    # for segment in rate_temp_schedule:
    #     print(f"{segment[0]:.0f}/h to {segment[1]:.0f} hold {segment[2]:.2f}h")
