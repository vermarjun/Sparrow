import socket, threading, sys, time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR,1); s.bind(('127.0.0.1',4481)); s.listen(50)
conns=[]
while True:
    c,_=s.accept(); conns.append(c)
