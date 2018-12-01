# circuitKiosk


# Enable Raspberry Camera Module to work with getUserMedia
First run raspi-config and enable the Pi to work with the camera module:
    $ sudo raspi-config

Select ‘5 - Interfacing Options’ and then ‘P1 Camera’. Enable the camera by highlighting ‘' and pressing enter.

No enable a module option to improve the camera modules picture quality.
 
    $ echo 'options bcm2835-v4l2 gst_v4l2src_is_broken=1' | sudo tee -a /etc/modprobe.d/bcm2835-v4l2.conf
	$ echo 'bcm2835-v4l2' | sudo tee -a /etc/modules-load.d/modules.conf