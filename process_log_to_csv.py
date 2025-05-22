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

# Initialize variables
last_written_time = None
output_file = 'graph.csv'

# Open the output CSV file
csvfile = open(output_file, 'w', newline='')
csv_writer = csv.writer(csvfile)
csv_writer.writerow(['datetime', 'temp'])

# Read log data from file line by line
with open(logfile, 'r') as file:
    for line in file:
        if "oven: Start" in line:
            # Close and reopen the output CSV file
            date_time_str = re.search(r'(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})', line).group(1)
            date_time = datetime.strptime(date_time_str, '%Y-%m-%d %H:%M:%S')
            output_file = f'graph-{date_time.strftime("%Y%m%d_%H%M%S")}.csv'
            csvfile.close()
            csvfile = open(output_file, 'w', newline='')
            csv_writer = csv.writer(csvfile)
            csv_writer.writerow(['datetime', 'temp'])
            last_written_time = None
            continue

        # Extract lines with temp=
        match = re.search(r'(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d{3} INFO oven: temp=(\d+\.\d+)', line)
        if match:
            date_time_str, temp = match.groups()
            date_time = datetime.strptime(date_time_str, '%Y-%m-%d %H:%M:%S')

            if start_datetime and date_time < start_datetime:
                continue

            if last_written_time is None or date_time >= last_written_time + timedelta(seconds=60):
                csv_writer.writerow([date_time.strftime('%Y-%m-%d %H:%M:%S'), temp])
                last_written_time = date_time

# Close the output CSV file
csvfile.close()

