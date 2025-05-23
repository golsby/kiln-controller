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

if __name__ == "__main__":
    rate_temp_hold_text = """
    50/h to 450 hold 1h
    50/h to 600 hold 0h
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

    parsed_rate_temp_hold = parse_rate_temp_hold(rate_temp_hold_text)

    for segment in parsed_rate_temp_hold:
        print(f"Rate: {segment[0]} °F/h, Temp: {segment[1]} °F, Hold: {segment[2]} h")

    time_temp_schedule = convert_to_time_temp(parsed_rate_temp_hold)
    print("Time-Temperature Schedule:")
    for t in time_temp_schedule:
        print(f"{t[0]*60:.0f} min -> {t[1]} °F")

    rate_temp_schedule = convert_to_rate_temp_hold(time_temp_schedule)
    print("Rate-Temperature Schedule:")
    for segment in rate_temp_schedule:
        print(f"{segment[0]:.0f}/h to {segment[1]:.0f} hold {segment[2]:.2f}h")
