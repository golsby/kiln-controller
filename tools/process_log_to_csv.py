import re
import csv
import sys
from datetime import datetime, timedelta

if len(sys.argv) < 2 or len(sys.argv) > 3:
    print("Usage: python script.py <logfile> [<start_datetime>]")
    sys.exit(1)

logfile = sys.argv[1]
start_datetime = None

if len(sys.argv) == 3:
    try:
        start_datetime = datetime.strptime(sys.argv[2], '%Y-%m-%d %H:%M:%S')
    except ValueError:
        print("Invalid date/time format. Use 'YYYY-MM-DD HH:MM:SS'")
        sys.exit(1)

# Read log data from file
with open(logfile, 'r') as file:
    log_data = file.read()

# Extract lines with temp=
temp_lines = re.findall(r'(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d{3} INFO oven: temp=(\d+\.\d+)', log_data)

# Write to CSV file
with open('output.csv', 'w', newline='') as csvfile:
    csv_writer = csv.writer(csvfile)
    csv_writer.writerow(['date', 'time', 'temp'])

    last_written_time = None
    for line in temp_lines:
        date_time_str, temp = line
        date_time = datetime.strptime(date_time_str, '%Y-%m-%d %H:%M:%S')

        if start_datetime and date_time < start_datetime:
            continue

        if last_written_time is None or date_time >= last_written_time + timedelta(seconds=60):
            csv_writer.writerow([date_time.strftime('%Y-%m-%d'), date_time.strftime('%H:%M:%S'), temp])
            last_written_time = date_time